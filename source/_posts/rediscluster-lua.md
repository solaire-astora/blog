---
title: 在redis-cluster模式下使用lua脚本
date: 2023-09-03 22:13:29
tags:
  - redis
  - lua
---
由于`redis cluster`不支持事务，在一些原子性的操作时无法使用`Multi`。因此`lua`脚本成了最合适的选择，但是由于`redis`在`cluster`下多个`slot`的问题，使用`lua`稍不注意会导致很多问题。
<!--more-->
# 跨`slot`使用`lua`脚本
`Redis Cluster`将整个数据集分为16384个槽位，每个槽位可以分配给集群中的一个节点或多个节点，每个节点可以负责多个槽位。
`Redis Cluster`使用哈希槽（hash slot）来实现数据的分布和负载均衡。具体来说，当一个客户端向Redis Cluster发送一个命令时，Redis Cluster首先对命令中的键（key）进行哈希计算，得到一个哈希值，然后将该哈希值对16384取模，得到一个槽位号，最后将命令转发给负责该槽位的节点处理。
通过使用哈希槽，`Redis Cluster`可以实现数据的分布和负载均衡，同时也可以实现节点的动态扩容和缩容。当一个节点加入或离开集群时，`Redis Cluster`会自动将该节点负责的槽位重新分配给其他节点，从而保证整个集群的数据分布均衡。
如下图所示，是我的一个测试集群的槽位分布：
![redis cluster 的槽位分布输出（IP 已遮盖）](https://cdn.redhand.com.cn/img/20230907165408.png)
我的集群中有6个节点，分成了3组节点，每组都互为主备。此时执行以下两个`set`语句，并且获取它们所在的槽位：
```redis
SET test01 1
SET test02 1
CLUSTER KEYSLOT test01
CLUSTER KEYSLOT test02
```
可以发现它们的槽位分别在1840和14163上：
![lua 脚本在 cluster 模式下报错的输出](https://cdn.redhand.com.cn/img/20230907170032.png)
此时根据之前的槽位分布我们可以知道，`test01`存在于第一组节点，`test02`存在于第三组节点。
此时执行简单的`lua`脚本：
```redis
EVAL "return redis.call('get', KEYS[1]) + redis.call('get', KEYS[2])" test01 test02
```
根据不同的redis版本和实现，可能会返回`1, null`，也可能报错：`CROSSSLOT Keys in request don't hash to the same slot`。
提示很清晰，是因为`test01`和`test02`不在同一个`slot`上。但是根源其实是不在同一个机器上。我们再插入一条新的key：
```redis
SET test1 1
```
修改一下`lua`脚本并且执行：
```redis
EVAL "return redis.call('get', KEYS[1]) + redis.call('get', KEYS[2])" test01 test1
```
可以看到成功返回了2。这是因为查看`test1`的`slot`，发现是1840，处于第一个节点上。因此我们可以得出结论，无法在`lua`脚本内操作两个不同的节点上的key。又由于我们无法预先规划hash算法的值，也无法得知`slot`究竟会怎么在节点上分布，因此可以大致认为在`lua`中操作多个key是不允许的。
# `redis` hashtag
为了应对这种问题，我们引入了hashtag。查看以下样例：
```
set test{01} 1
set test2{01} 1
CLUSTER KEYSLOT test{01}
CLUSTER KEYSLOT test2{01}
```
可以发现`test{01}`和`test2{01}`都落在9191这个`slot`上。这是因为在指定了hashtag之后，`redis`就只会用hashtag中的内容作为hash。例如`test{01}`和`test2{01}`就都是使用`01`作为hash内容，使得他们可以进入到同一个槽位中。
这种做法特别适合不同业务中同一个id对应不同key的情况。例如在`redis`中我们分别存储了玩家的等级和经验：`level:{userid}`和`exp:{userid}`，使用这种做法就可以让属于一个玩家的不同key都进入到同一个`slot`，方便在脚本中原子地操作。
当然，使用这种做法可能会导致`key`的存储不平衡，最极端的例子就是hashtag内的key是同一个，那就会导致所有的数据都进入同一个`slot`。
# 另一种办法
如果你用的`redis`版本足够新（>7.0)，那么可以尝试如下的`lua`脚本：
```lua
#!lua flags=allow-cross-slot-keys
return redis.call('GET', ARGV[1]) + redis.call('GET', ARGV[2])
```
请注意，这里的`lua flags`只是使得我们可以跨`slot`访问key。如果没有这么赋值，一般会出现报错`Lua script attempted to access a non local key in a cluster node`。但是依旧不允许传入不在同一个节点的keys。
因此我们这里使用的是`ARGV`而非`KEYS`。
# 总结
综合来看，在`redis cluster`下使用`lua`脚本是唯一可以原子化操作序列的方式。为了避免跨`slot`操作key，可以使用hashtag，也可以用新特性直接操作。但是hashtag无疑是更好的方式，毕竟跨了`slot`对性能也略有影响，官方也不建议这么操作。