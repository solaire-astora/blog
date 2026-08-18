---
title: linux进程内存占用分析
date: 2023-03-27 11:48:09
toc: true
tags:
  - linux
---

线上服务一般都会遇到因为代码bug或者逻辑不合理导致内存占用暴涨的情况（例如内存泄露），也有可能在线上环境发现内存占用太高和预估不符的情况。单纯分析代码人肉查问题不总是靠谱，此时最直观的方式就是profile进程的内存占用问题。如果遇到了`c/c++`开发的服务，或者需要分析类似`java`堆外内存泄露的问题，`gperf（tcmalloc）`是一个比较好的选择。

<!-- more -->

# 进程内存模型分析

内存占用首先需要定位的就是内存占用不合理的地方在哪？一般情况下都发生在堆内存（毕竟栈内存空间太有限了，没啥可以发挥的地方）。也可能是使用了海量的共享内存，但是这部分一般都是可控的。

查看内存占用一般用`top`就能直观地看到一部分信息，`top -p <pid>`查看对应进程内存占用，一般长这样：

```txt
top - 19:37:44 up 383 days,  3:42,  1 user,  load average: 0.11, 0.03, 0.01
Tasks:   1 total,   0 running,   1 sleeping,   0 stopped,   0 zombie
%Cpu(s):  0.5 us,  0.2 sy,  0.0 ni, 99.3 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st
MiB Mem :   1986.9 total,    161.8 free,    333.4 used,   1491.7 buff/cache
MiB Swap:      0.0 total,      0.0 free,      0.0 used.   1471.0 avail Mem

  PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND   SWAP  CODE  DATA
             root  20   0   55548   7644   5956 S   0.0   0.4   0:00.03 nginx        0   856  1760
```

这是我的测试服务器上的一个`nginx`的截图。

有关于进程的内存的条目有五项

- `VIRT` 虚拟内存
- `RES` 实际物理内存占用
- `SHR` 共享内存
- `CODE`是代码段占用的内存
- `DATA`是指堆、栈上**申请的总空间**

RES代表了实际上占用的物理内存，内存占用过高也往往是讨论的这一块，这块包括了堆，栈，使用的共享内存等。`man top`里说到`RES=CODE+DATA`，这在大部分情况下说的都是**不正确**的，很显然从上图中我们就能看出了。

## `SHR RES`和`VIRT`的关系

以下是一段申请共享内存的样例代码：

```c++
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/ipc.h>
#include <sys/shm.h>
#include <pthread.h>

const   int SHARED_SIZE = 16 * 1024 * 1024;
const   int SHM_TEST_ID = 666;


int main(int argc, char* argv[])
{
    printf( "press <enter> to continue1" );
    while( getchar() != '\n' );
    // 申请16M虚拟内存
    int  fdShMem = shmget(SHM_TEST_ID, SHARED_SIZE, 0666|IPC_CREAT);
    if (fdShMem == -1)
    {
        printf("Create shared memory failed.\n");
        exit(-1);
    }
    // 此时virt内并没有shm的16M内存占用
    printf( "press <enter> to continue2" );
    while( getchar() != '\n' );
    void*  pSHM = shmat(fdShMem, NULL, 0);
    // 此时virt内已经有了shm的16M内存占用 但是res内还没有变化
    printf( "press <enter> to continue3" );
    while( getchar() != '\n' );
    memset(pSHM, 't', SHARED_SIZE / 4);
    // 此时res已经加上了4M的内存占用了
    printf( "press <enter> to continue4" );
    while( getchar() != '\n' );
    return 0;
}
```

以下分别是执行这段代码之后的几个时间点的内存占用信息：

```txt
# ① 启动后（尚未 shmget）
  PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND   SWAP  CODE  DATA
                20   0    2488    576    512 S   0.0   0.0   0:00.00 test         0     8   312

# ② shmget 之后：VIRT 都没有变化
  PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND   SWAP  CODE  DATA
                20   0    2488    576    512 S   0.0   0.0   0:00.00 test         0     8   312

# ③ shmat 之后：VIRT +16M，但 RES / SHR 不变
  PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND   SWAP  CODE  DATA
                20   0   18872    576    512 S   0.0   0.0   0:00.00 test         0     8   312

# ④ memset 之后：RES / SHR 各 +4M
  PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND   SWAP  CODE  DATA
                20   0   18872   5240   5156 S   0.0   0.3   0:00.00 test         0     8   312
```

参考文中注释的内容，我们可以总结出几点内容：

- `shmget`申请贡献内存连`virt`部分都不会新增。应该只是在内核空间中新建了一个共享内存的信息。
- `shmmat`会给`virt`增加16M的占用。但是此时`RES`和`SHR`都没有任何增长。
- `memset`真正用到了共享内存申请的空间，此时可以看到`RES`和`SHR`都增加了大概4M的空间。

这里很显然我们会得到一个结论：申请的共享内存无论是否使用，都会增加`VIRT`的占用（毕竟是增加了虚拟内存空间），但是只有实际上内存页被访问到之后，才会真正地增加内存使用（应该是发生了缺页中断之后，才会真正地有一个映射）。

因此我们要有一个清晰的认知，内存占用的大小主要关注`RES`，只要`RES`维持在一个合理的范围内，实际上是很难发生`OOM`的。但是同时`VIRT`也并非不需要关注，如果`VIRT`超过`RES`很多，可能就代表在某个特殊的时刻内存使用会暴涨了。主要的原因来自于申请却未使用到的共享内存。

## 进程内存细节查看

类似的信息也可以在`/proc/<pid>/status`里查看到，例如我服务器上的`nginx`：

```
VmPeak:    55280 kB
VmSize:    55280 kB
VmLck:         0 kB
VmPin:         0 kB
VmHWM:      1496 kB
VmRSS:      1496 kB
RssAnon:            1448 kB
RssFile:              48 kB
RssShmem:              0 kB
VmData:     1360 kB
VmStk:       132 kB
VmExe:       856 kB
VmLib:     12636 kB
VmPTE:        92 kB
VmSwap:        0 kB
```

其中`VmSize`对应`VIRT`，`VmRSS`对应`RSS`。其余的信息都可以google到，不再赘述。

但是这里只输出了全局的修改，我们日常定位内存占用异常的时候会想要知道进程的堆占用，共享内存占用（比如python的内存管理就会直接用`mmap`申请大段内存）等等。此时可以查看`/proc/<pid>/smaps`的数据，它是基于`/proc/<pid>/maps`的扩展，展现了更加详细的信息。

每一段`VMA`（虚拟内存区域，即`vm_area_struct `指向的区域）都在`smaps`里分别列出。以下是我的某个在线服务的堆内存段`VMA`：

```
2fd84000-e9f5a000 rw-p 00000000 00:00 0                                  [heap] // 基础信息
Size:            3049304 kB // 虚拟内存大小
Rss:             3033768 kB // 物理内存占用
Pss:             3033768 kB // 和其它进程平摊(如果有共享内存)计算后的实际物理使用内存
// 以下字段标记 共享/非共享_干净页/脏页的数据
Shared_Clean:          0 kB 
Shared_Dirty:          0 kB
Private_Clean:         0 kB
Private_Dirty:   3033768 kB 
Referenced:      3033768 kB // 被访问到的页 用于页面替换算法
Anonymous:       3033768 kB // 匿名映射的物理内存 用这个指标可以判断这段内存有多大部分不来自于文件
AnonHugePages:         0 kB // THP(transparent huge pages)占用的大小，一般情况下出于性能考虑是禁用的
Swap:                  0 kB // 交换分区大小
KernelPageSize:        4 kB // 内核一页的大小
MMUPageSize:           4 kB // MMU页大小
Locked:                0 kB // 常驻物理内存的大小，这些页不会被换出
```

其中第一行的基础信息对应情况如下：

- `2fd84000-e9f5a000` 虚拟内存的开始-结束地址。
- `rw-p` 内存段的权限。rw就是一般权限标识了，最后的p代表私有（s代表共享）。
- `00000000` 该虚拟内存段起始地址在对应的映射文件中以页为单位的偏移量。因为堆内存是直接申请的内存页，不对应一个文件，所以是0或者`vm_start`/`PAGE_SIZE`。
- `00:00` 文件的主设备号和次设备号。对匿名映射来说，始终为`00:00`
- `0` 被映射到虚拟内存的文件索引节点号，对于匿名映射始终是0

同样的一个进程下，我们还可以看到链接的`libc++`动态库的`vma`信息：

```
7fab8cd44000-7fab8ceb8000 r-xp 00000000 fc:01 1184293                    /usr/local/gcc-8.3.0/lib64/libstdc++.so.6.0.25
Size:               1488 kB
Rss:                 928 kB // 对比这里的Rss/Pss，因为它被很多进程共享 所以内存占用也平摊了
Pss:                 100 kB
Shared_Clean:        916 kB
Shared_Dirty:          0 kB
Private_Clean:        12 kB
Private_Dirty:         0 kB
Referenced:          928 kB
Anonymous:             0 kB
AnonHugePages:         0 kB
Swap:                  0 kB
KernelPageSize:        4 kB
MMUPageSize:           4 kB
Locked:                0 kB
```

请注意这里的`Rss`段，因为`libc++`这个动态库被许多进程共享，所以实际由本进程承担的只有100k。但是要注意的是这里无论是计算`Rss`还是`Pss`之和都和`Res`对不上。可能的原因也许来自于`malloc`内存申请的方式会留有缓存，以及内存对齐等原因。

至此通过对于这些信息的分析我们已经可以大致定位到内存占用的大头了：堆、共享内存，包括具体到是否是第三方库以及是哪个库。

# 使用`tcmalloc`分析堆内存

一般情况下我们认为内存出现问题的原因都会来自于自己的堆内存。 因为如果在代码中使用了共享内存，那么量肯定是可以预期的，入口也非常稳定。加一些日志一般都可以很简单地定位到问题。而第三方库测试比较充分，出问题概率也不高。诸如`new`和`delete`不匹配之类的花活一般都是出现在我们的业务代码中的。

使用`tcmalloc`可以比较方便地分析内存申请分配的情况。请注意不要使用太高的版本的`gperf`，否则在申请大块内存的时候会触发异常。我在自己的环境中测试出一个可行的组合是`gperf2.2`+`libunwind1.6.2`(64位机器需要)。

工程有两种方式引入`tcmalloc`，静态链接和使用`LD_PRELOAD`。静态链接方式需要在链接的时候加入参数`-ltcmalloc`（库目录需要包含`libtcmalloc.a`）。`LD_PRELOAD`则是在shell中类似如下定义：

```shell
export LD_PRELOAD=/usr/local/lib/libtcmalloc.so #替换malloc
```

开启`profile`也有两种方式，侵入代码或者定义信号。使用信号很简单，只需要修改`shell`环境，如下所示：

```shell
export HEAPPROFILESIGNAL=12 # 使用SIGUSR2信号启用profile
export HEAPPROFILE=svr.hprof # profile文件名
#取消自动dump
export HEAP_PROFILE_ALLOCATION_INTERVAL=0 
export HEAP_PROFILE_DEALLOCATION_INTERVAL=0
export HEAP_PROFILE_INUSE_INTERVAL=0 
export HEAP_PROFILE_TIME_INTERVAL=0
```

这样内存稳定之后发送信号触发dump profile文件:

`````shell
kill -12 `pidof <svr>`
`````

就会生成对应的profile文件了。

或者也可以在代码中显示地开启关闭和触发dump，如以下代码：

```c++
#include <iostream>
#include "gperftools/heap-profiler.h"
const int len = 1024 * 1024;

void test1() {
  int i = 100;
  while (i--) {
    char *buf = new char[len];
  }
}

void test2() {
  int i = 100;
  while (i--) {
    char *buf = new char[len];
  }
}

int main() {
  HeapProfilerStart("./test1.log");
  int i = 100;
  while (i--) {
    char *buf = new char[len];
  }
  test1();
  test2();
  test2();
  HeapProfilerDump("test");
  HeapProfilerStop();
  return 0;
}
```

编译：

```shell
gcc -o test test.cc -std=c++11 -lstdc++ -ltcmalloc
```

运行之后我们会得到4个文件：

```shell
Starting tracking the heap
Dumping heap profile to ./test.log.0001.heap (101 MB currently in use)
Dumping heap profile to ./test.log.0002.heap (202 MB currently in use)
Dumping heap profile to ./test.log.0003.heap (303 MB currently in use)
Dumping heap profile to ./test.log.0004.heap (test)
```

这是因为默认一次性分配超过100k内存之后就会dump一次。可以设置`HEAP_PROFILE_INUSE_INTERVAL`为0关掉它。其他的选项设置还有：

- `HEAP_PROFILE_ALLOCATION_INTERVAL`: 内存每增长这一数值之后就dump 一次内存。默认1G。
- `HEAP_PROFILE_TIME_INTERVAL`: 每隔一段时间dump一次内存。默认为0即不开启。

分析得到的文件`./test.log.0004.heap`，使用如下命令转换成pdf（否则调用链复杂的程序看着有些麻烦）：

```cpp
pprof test test.log.0004.heap --pdf > test.pdf
```

![pprof 生成的内存分配调用图：main 下 test2 占 200MB、test1 占 100MB](https://cdn.redhand.com.cn/img/image-20230417231923921.png)

生成的pdf如图所示：可以知道`test2`申请了50%的内存，`test1`申请了25%，`main`的调用链上申请了100%，但是其中只有25%是`main`自己申请的。通过调用图我们就可以分析出在申请的过程中哪个函数申请了较多未释放的内存了。

# 结语

在本文中我们通过分析进程的内存空间，知道了如何定位内存占用的大头。并且针对堆内存使用`tcmalloc`来定位可能的热点。
