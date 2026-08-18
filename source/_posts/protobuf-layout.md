---
title: protobuf的二进制编码结构
date: 2023-08-29 10:23:36
tags:
  - protobuf
  - go
toc: true
---
[Protocol Buffers](https://github.com/protocolbuffers/protobuf)是一种跨平台的序列化数据结构协议，通过`.proto`文件作为`DSL`描述，并且将数据以二进制方式字节流方式编码。了解`protobuf`的编码方式，对于合理组织自己的协议，以及优化业务代码都比较有帮助。
<!--more-->
# value的编码
`protobuf`中的value类型类型大致可以分为这几种，我们称之为`wire type`，和`protobuf`的类型对应关系如下：
```go
// value类型
const (
	VarintType     Type = 0 // 所有不定长数字 一般我们常用到的都属于这种
	Fixed32Type    Type = 5 // 32位定长数字 例如fixed32和sfixed32
	Fixed64Type    Type = 1 // 64位定长数字 例如fixed64和sfixed64
	BytesType      Type = 2 // 各种不定长数据 message bytes repeated string
	StartGroupType Type = 3 // 废弃
	EndGroupType   Type = 4 // 废弃
)
// 每个具体的prototype对应的wire type
var wireTypes = map[protoreflect.Kind]protowire.Type{
	protoreflect.BoolKind:     protowire.VarintType,
	protoreflect.EnumKind:     protowire.VarintType,
	protoreflect.Int32Kind:    protowire.VarintType,
	protoreflect.Sint32Kind:   protowire.VarintType,
	protoreflect.Uint32Kind:   protowire.VarintType,
	protoreflect.Int64Kind:    protowire.VarintType,
	protoreflect.Sint64Kind:   protowire.VarintType,
	protoreflect.Uint64Kind:   protowire.VarintType,
	protoreflect.Sfixed32Kind: protowire.Fixed32Type,
	protoreflect.Fixed32Kind:  protowire.Fixed32Type,
	protoreflect.FloatKind:    protowire.Fixed32Type,
	protoreflect.Sfixed64Kind: protowire.Fixed64Type,
	protoreflect.Fixed64Kind:  protowire.Fixed64Type,
	protoreflect.DoubleKind:   protowire.Fixed64Type,
	protoreflect.StringKind:   protowire.BytesType,
	protoreflect.BytesKind:    protowire.BytesType,
	protoreflect.MessageKind:  protowire.BytesType,
	protoreflect.GroupKind:    protowire.StartGroupType,
}
```
如果不确定所用的数据类型对应的什么`wire type`也可以从导出的代码里看一下注释，以下代码是官方`go protobuf`导出的部分代码：
```go
type TestMessage struct {
	Name   string           `protobuf:"bytes,1,opt,name=name,proto3" json:"name,omitempty"`
	Age    uint32           `protobuf:"varint,2,opt,name=age,proto3" json:"age,omitempty"`
	Nested []*NestedMessage `protobuf:"bytes,3,rep,name=nested,proto3" json:"nested,omitempty"`
}
```
接下来我们分开整理一下`wire type`的数值是如何保存的。
## `Varint`
这里包括了`uint32`,`uint64`,`in32`等整数类型。需要编码`varint`时，会先将对应的整数转换成`uint64`，之后再存成`varint`。例如编码`int32`时，代码如下所示：
```go
var v int32
var b []bytes
protowire.AppendVarint(b, uint64(v))
```
因此我们可以将`varint`的编码看做是`uint64`的编码。对于8字节的`varint`，大部分情况下前边都是有很多0占据的，为了节省空间，`varint`的编码采用每个byte的第一位作为标识位，后7位作为数据位的方式。
例如对于123456这个整数，`uint64`的编码是`00011110001001000000`（忽略前边空的byte），`varint`编码方式如下：

:::diagram pb-varint
fig. varint 编码三步：按 7 bit 分组、小端排列、补上 msb
:::

这种编码中，每个byte最高位都叫做最高有效位，most significant bit即msb。如果最高有效位是1，那么代表后边的字节还属于这个`varint`的，否则就代表这是最后一个字节了。由此我们可以节约一些空间，例如对于123456就可以用3个字节编码，节省了5个字节。
同理在解码的情况下，就是依次读取字节，直到最高位为0为止，再将读到的字节按照小端序转换为对应的数字。
对于比较熟悉[补码](https://zh.wikipedia.org/zh-cn/%E4%BA%8C%E8%A3%9C%E6%95%B8)的读者会发现，这种方法在遇到负数的时候是很低效率的。例如-1转换成`uint64`是18446744073709551615，如果直接用`varint`存储就需要10个字节，十分低效。为此`protobuf`引入了`zigzag`编码。本质上`zigzag`也是非常简单的，转换方式如下：
```go
// 编码zigzag
func EncodeZigZag(x int64) uint64 {
    return uint64(x<<1) ^ uint64(x>>63)
}
// 解码zigzag
func DecodeZigZag(x uint64) int64 {
	return int64(x>>1) ^ int64(x)<<63>>63
}
```
在`zigzag`编码下，编码会变成如下映射：
![ZigZag 编码：有符号整数与无符号整数的交错映射关系](https://cdn.redhand.com.cn/img/20230902221426.png)
这样编码的长度和绝对值相关，规避了小负数补码的问题。
**请注意**，`varint`中，只有`sint32`和`sint64`是使用`zigzag`方式编码的。因此，如果在业务中使用非负数，可以使用`uint32`和`uint64`，否则需要使用`sint32`和`sint64`以减少编码长度。（很疑惑`int32`为什么有必要存在，或者说为什么`int32` 不直接使用`zigzag`）。
## `fixed32`和`fixed64`
这两项就没有太多可说的，就是存储4位or8位的数字，主要用于存储`float`和`double`。对于某些特殊场合的整数，比如自定义ID算法计算得到的`uint64`的ID时，因为大概率可以确定ID一定是63~64位，使用`varint`大概率是要比8位要多了，我们可以选用`Fixed64`这样的定长类型。
唯一需要注意的是，对于`float`和`double`需要转换成IEEE 754的浮点数标准存储。一般情况下各语言的标准库都能处理好，只有在实现自己的`protobuf`库时需要额外注意。
## `Bytes`
这个类型包含了`message bytes repeated string`，编码方式大同小异，都是长度+数据的组合。这里的长度统一都使用了`varint`来编码。
例如对于`message`的编码，会先编码整个`message`的长度。再递归地编码这个`message`。如下图所示：

:::diagram pb-bytes-field
fig. 长度前缀 + 数据：嵌套 message 的编码方式
:::

对于字符串，额外的操作是校验字符串是否符合`utf-8`规范。
额外说明一下对于`repeated`，在`protobuf2`版本内可以指定是否为`packed`，例如：
```protobuf
repeated uint32 ids = 1 [packed=true];
```
这种声明的方式在`protobuf3`中已经废弃了，所有的`repeated`都是按照`packed`的方式来压缩。两种压缩的区别如下：

| | 字节排布 |
| --- | --- |
| `packed` | `Type` `Value` `Value` `Value` |
| `unpacked` | `Type` `Value` `Type` `Value` `Type` `Value` |

`packed` 只写一次 `Type`，后面连续跟多个 `Value`；`unpacked` 每个 `Value` 前都要重复一遍 `Type`，因此元素越多、`unpacked` 的冗余越大。
# kv结构
不同于`json`，`xml`这类的自描述协议，`protobuf`本身附带的信息不足以完全还原`protobuf`结构体。拿到了一段字节流想要还原整个`proto`是不现实的（当然，也可以靠猜的）。但是给定一段字节流，我们至少可以从中还原出field的数量和大致类型。
如下是一段简单的`proto`文件，我们可以用`protoc`导出并且在`go`工程中引用它：
```protobuf
syntax = "proto3";
package test;
option go_package = "./testpb";
message MyMessage {
    string name = 1;
    uint32 age = 2;
    repeated NestedMessage nested = 3;
}
message NestedMessage {
    string country = 1;
    int32 code = 2;
}
```
根据这个`proto`生成一个结构体，并且dump序列化之后的字节流：
```go
func generateBin() {
	msg := testpb.MyMessage{
		Name: "123",
		Age:  10,
		Nested: []*testpb.NestedMessage{
			{
				Country: "China",
				Code:    -10086,
			},
		},
	}

	bytes, err := proto.Marshal(&msg)
	if err != nil {
		log.Fatalln(err)
	}
	err = os.WriteFile("test.bin", bytes, 0644)
	if err != nil {
		log.Fatalln(err)
	}
}
```
这样我们就可以解析名为`test.bin`的字节流文件。首先先上结论，`test.bin`的数据分布如下图所示：

:::diagram pb-full-stream
fig. test.bin 的完整字节流分解
:::

数据分为三段，编码后的字节流是以k-v形式组成了若干段数据，再将这些数据段简单拼接在一起得到的。其中v部分就是上一章节中描述的的数据，接下来我们先解释一下k的形式：
# `protobuf`的`field`
在上一节中，我们可以从图中发现对应`MyMessage`中3个`field`。其中每个field都是以k-v的形式组合，例如`string name = 1;`占据了第0~4个byte，其中第一个byte用于描述`field `。每个`field`的形式如下所示：

:::diagram pb-field-tag
fig. tag 字节：高 5 位是 field Num，低 3 位是 wire Type
:::

其中`Num`就是在`proto`里定义的序号，`Type`就是前文中提到的`wire type`，`field`和`type`一起被编码进了同一个byte中，`field = Num<<3 | Type`。
这里的`field`是用`varint`的形式存储的。因此在业务开发遇到`field`较多的消息时，建议谨慎规划0\~15的`field num`，尽量将这一段留给经常需要设置的`field`。原因是只有0~15的数左移3位之后还能保持7个bit，这样才能在一个`varint`内编码完。
作为例子，对于以下声明
```protobuf
uint32 testcode = 100;
```
这个`field`的`varint`编码就是(小端序 补齐msb)，需要2个byte。
```
10100000 00000110
```
事实上，虽然`field`是使用`varint`编码，但是它最大长度为32位。因此`field num`的最大序号为536,870,911（1<<(32-3) - 1)。
## message编码
最后在编码了`field`和`value`之后，`message`编码就是简单地将`k-v`依次拼接得到。
事实上，`protobuf`不要求`field number`有序，也就是说k-v完全可以按照"3-2-1"这样拼接；同样地，也不要求tag是完全的，对于以下消息，就只会编码field1和field3：
```go
msg := testpb.MyMessage{
		Name: "123",
		// Age:  10, age不编码进去
		Nested: []*testpb.NestedMessage{
			{
				Country: "China",
				Code:    -10086,
			},
		},
	}
```
`protobuf`反序列化字节流时，也是依次读取每个field的kv组合并且填充到结构体中。
至此我们可以推断出一些结论：
首先，以下这两段代码生成的是一致的字节流。
```go
func marshal() {
	msg := testpb.MyMessage{
		Name: "123",
		Age:  10,
	}
	bytes1, _ := proto.Marshal(&msg)

	bytes2 := []byte{}
	bytes2 = protowire.AppendTag(bytes2, 1, protowire.BytesType)
	bytes2 = protowire.AppendString(bytes2, "123")
	bytes2 = protowire.AppendTag(bytes2, 2, protowire.VarintType)
	bytes2 = protowire.AppendVarint(bytes2, 10)

	fmt.Println(bytes.Equal(bytes1, bytes2))
}
```
这样我们可以对于用到`protobuf`的地方做一些灵活的修改，例如业务中动态地给msg添加信息（一般用在网关，转发服务上）。
其次，注意到在编码的结果中`field name`，即`Name`，`Age`之类的信息是不编码进最终的字节流中的。因此可以随意给字段命名，不用考虑长度的影响（相对地`json`和`msgpack`就需要考虑到这一点）。此外两个结构体如果有部分字段的`field`是相同的（number和type），那么它们可以在某种程度互相兼容，只是会丢失无法对齐的部分信息。这也是`protobuf`前后向兼容性的来源。
# 总结
通过对`protobuf`的编码方式分析，我们可以得到一些指导我们业务开发的结论。
- 对于有符号整数，尽量使用`sint32`和`sint64`，这样可以使用`zigzag`编码以避免补码对`varint`带来的影响。
- 如果已知某些`field`是大整数，二进制编码占用7~8个byte，那么可以考虑使用`fixed32`或者`fixed64`以避免`varint`带来的额外开销。
- 规划`field number`时优先将0~15的位置留给更经常被赋值的`field`，以减少整体的编码长度。
- 编解码用的`proto`文件可以不一定完全相同，只要类型能对齐就能解码。
- 可以方便地给字节流增加一些`field`，但是减少和替换就麻烦一点（最糟糕情况需要遍历完整个byte数组）。
- 在只有字节流文件的情况下，我们最多能判定目标`proto`协议至少有多少个`field`，但是无法正确地解码。因为不同类型的value会编码成相同`wire type`，例如`varint`，没有`proto`文件的情况下我们无法确定是要解码成`uint64`还是`int64`。
- 前边这项也告诉我们`protobuf`无法兼容前后版本同一个`field type`有变化的情况，如果需要变更`field type`建议新增加一个`field`。
# 进一步思考
我在研究`protobuf`的结构时，一直在思考：`protobuf`需要两边都有一个`DSL`文件才能正确编解码，原因就在于`wire type`的类型实在太少了，不能完全描述完数据结构。但是对于`field number`来说，（1<<(32-3) - 1)的最大限制应该是一个无论如何都达不到的地步。所以再多给`wire type`3位数据，让`wire type`最大值来到64个，就应该可以摆脱`DSL`了。
但是这样几乎板上钉钉需要2个byte来描述`field`，对于大部分只有小整数交换的`message`来说要增加1/3~25%的编码长度。想到这里我不得不对`google`的人说：
![熊猫头表情：这方面还是你懂得多啊|198](https://cdn.redhand.com.cn/img/20230903192719.png)

可以下载样例[demo](https://github.com/solaire-astora/proto_layout_demo)并且运行`make`编译工程。