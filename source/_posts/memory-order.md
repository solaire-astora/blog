---
title: c++中的memory order问题
date: 2024-03-17 17:33:00
tags:
  - cpp
toc: true
---
在`C++`中，我们使用`atomic`时会发现相关操作都有一个可选的参数`std::memory_order`，本文就分析以下这几种`memory_order`的用法，以方便大家写出更加高效的多线程代码。
<!-- more -->
首先确定的是，`memory_order`这件事情只存在于`atomic`中。如果使用的不是`atomic`，那么可以认为代码本身就不是线程安全的，自然也没必要考虑内存模型了。
例如考虑以下代码：
```cpp
int counter = 0;
void increment() { 
	for (int i = 0; i < 10000; ++i)
		counter++;
	}
}
int main() {
    std::thread t1(increment);
    std::thread t2(increment);

    t1.join();
    t2.join();
}
```
很显然这段代码中对于`counter`的操作是没什么线程安全可言的，毕竟`++`这种操作不具有原子性。很显然我们可以考虑更新一下实现：
```c++
std::atomic<int> counter(0);

void increment() {
    for (int i = 0; i < 10000; ++i) {
        counter.fetch_add(1, std::memory_order_relaxed);
    }
}
```
`fech_add`的第一个参数很好理解，就是原子地+1，但是第二个参数比较让人费解，`std::memory_order_relaxed`。一般情况下我们在别的语言里操作`atomic`的时候都不会有这种参数，为什么在`c++`里有呢？
> 例如`golang`中是`atomic.AddInt64`，`java`中是`incrementAndGet`。

首先给出结论，`std::memory_order_relaxed`顾名思义是内存序的一种。如果不指定默认使用的内存序是`memory_order_seq_cst`，它的效果和`go`以及`java`里的那些接口是几乎一致的。
# CPU指令乱序执行
为了说明内存序的用处，先复习一个基本的概念：CPU指令的乱序执行。这个概念如下图所示：

:::diagram memory-order-reorder
fig. 顺序执行与乱序执行：无依赖的指令可以被提前
:::

如果两条指令之间没有依赖，那么CPU可能不会保证指令之间的顺序性，而是如图所示把一些指令提前执行充分利用CPU上的逻辑单元。在非并发的情况下不会有什么问题，但是对于并发的代码就会带来一些bug，考虑以下代码：
```cpp
int counter = 0;

std::atomic<int> flag(0);
std::vector<int> q; // vector不是线程安全的 但是我们先假装它是XD

void consume() {
	for(;;) {
		{
			while(q.pop_back() != q.end()) {
				// 消费逻辑
			}
		}
		if (flag.load(std::memory_order_relaxed) != 0) {
			while(q.pop_back() != q.end()) {
				// 继续消费剩余事件
			}
			break;
		}
		counter++;
	}
}

void quit() {
	// finish produce
	{
		q.push_back(xxx);
	}
	flag.store(1, std::memory_order_relaxed);
}
```
在样例代码中，`consume`负责消费一些事件，在监听到`flag`被设置成1的时候，`quit`在代码退出的时候调用，先负责把一些还没有发送出去的事件都发送了，再设置`flag`。其中`std::memory_order_relaxed`用于模拟允许CPU指令乱序的情况。
显然，`flag`的读写和`q`的读写是没有数据依赖的，遇上在单线程中不会出问题的指令重排，在多线程中就出现了问题：在`quit`中，`store`指令可能被调度到了生产剩余事件的指令之前，导致`consume`在`load`到`flag=1`时，剩余事件还没有完全生产完，最终导致最终`q`中还残留了数据
>所以我们知道了第一个内存序`std::memory_order_relaxed`，对于指令乱序完全不负责，因此比较适合一些单纯的计数器。
# `std::memory_order_release`用于发布
`memory_order_release`确保对**共享变量**的读写操作不会因为重排导致在当前原子操作之后发生。也就是相当于对于上例的`quit`函数，人为地插入了一个屏障（barrier）：
```c++
void quit() {
	// finish produce
	{
		q.push_back(xxx);
	}
	// ------------在此之前的所有内存读写都不能重排到后边----------------------
	// 请注意，这里换成了std::memory_order_release
	flag.store(1, std::memory_order_release); 
}
```
请注意，这里提到的屏障指的是**所有内存操作**，不单独指对于`flag`的，对于`q`的操作也生效。因此，我们可以保证`q.push_back`一定会发生在`flag.store`之前。
所以`memory_order_release`特别适合用来做类似“发布”的逻辑：我们往线程共用的内存中写入了一些数值，并且在最后”发布“给其他的线程，`memory_order_release`能保证其他线程看到`atomic`变量改变的时候，也一定能看到共用的内存的变化。
# `std::memory_order_acquire`用于接受
相反地，`std::memory_order_acquire`用于确保对**共享变量**的读写都不会因为重排到当前原子操作之前发生。以上例中的`consume`为例：
```c++
void consume() {
	for(;;) {
		{
			while(q.pop_back() != q.end()) {
				// 消费逻辑
			}
		}
		// 请注意，这里换成了std::memory_order_acquire
		if (flag.load(std::memory_order_acquire) != 0) {
			while(q.pop_back() != q.end()) {
				// 继续消费剩余事件
			}
			break;
		}
		// ------------在此之后的所有内存读写都不能重排到前边----------------------
		counter++;
	}
}
```
同样的，这里的内存操作也是所有的内存操作。因此`counter++`也不会被重排到`flag.store`之前。能够确保它不会在退出的时候还错误地自增。
因此`memory_order_acquire`很适合用于“监听”某些变量的变化：在监听到变量才能执行的内存操作不会被重排到之前。
可以看出一般`memory_order_release`和`memory_order_acquire`在多线程编程中都是成对使用，用于构建“生产者-消费者”模型或者“监听-发布”这样的逻辑。
# `std::memory_order_acq_rel`我全都要
`memory_order_acq_rel`可以理解为`memory_order_release`和`memory_order_acquire`的集合体，相当于以下的逻辑：
```cpp
{
	// ------------在此之前的所有内存读写都不能重排到后边---------------------- 
	int a = flag.lod(std::memory_order_acq_rel);
	// ------------在此之后的所有内存读写都不能重排到前边----------------------
}
```
可以说是最严格的内存序。但是要注意的是，它禁止的是它前后的指令重排不能跨越它，不代表在它之前的那些指令自己不能发生重排。
这么做肯定对于性能影响也是最大的，但是在其他语言中默认的`atomic`操作就类似这样（C++的默认内存序也是用它），因此也不用过多担忧，在吃不准应该用哪个内存序的时候用它一定不会带给你额外的bug。
# `std::memory_order_consume` 容易搞错的内存序
`memory_order_consume`类似`memory_order_acquire`，都是用于读操作。所以先说一个结论：任何用`memory_order_consume`的变量操作都建议替换成`memory_order_acquire`。
`memory_order_consume`的不同之处在于它对于指令重排的限制仅限于和对应的`atomic`**相关的内存操作**。考虑以下代码：
```c++
void thread1() {  
	std::string* p = new std::string("Hello");
	data = 42;
	ptr.store(p, std::memory_order_release);
}  
  
void thread2() {  
	std::string* p2;  
	while (!(p2 = ptr.load(std::memory_order_consume))); // (1)  
	assert(*p2 == "Hello"); // (2)  
	assert(data == 42); // (3)   
}
```
因为`*p2`是关联到`atomic`操作的语句，因此`*p2`不会被重排到(1)之前，所以`assert`肯定成立。但是(3)和`atomic`操作不关联，因此是有可能重排到(1)之前的。所以`assert`可能不过。
因此`memory_order_consume`相比于`memory_order_acquire`限制更小，所以对于内存的影响更小。但是因为这种语义暧昧容易混用的情况，在`c++20`中已经移除了。所以在这里建议统一使用`memory_order_acquire`。
# 总结
通过上文的分析，我们可以发现内存序主要通过限制**本线程**的对于内存操作的指令重排，使得**其他线程**见到的内存状态处于一个有序的状态。相比于其他语言，`C++`留给用户指定`atomic`操作时的内存序的途径，因此更有助于因地制宜在正确的结果和性能开销方面做出平衡。
总结几个内存序的使用场合：
## `memory_order_relaxed`
不限制任何内存重排，适用于简单的计数器以及非关键性的逻辑。
## `memory_order_release`和`memory_order_acquire`
最常用的组合，用于实现“生产者-消费者”或者“监听-发布”。
## `memory_order_acq_rel`
`memory_order_release`和`memory_order_acquire`的组合体，最多的性能开销换来最严格的内存序。如果你不知道该用啥，那就用它。一点点性能开销换来没有额外bug是很值得的，要知道多线程的内存处理带来的bug简直是生命燃烧机。
## `memory_order_consume`
别用。`c++`标准里都要去掉的东西，别头铁了。