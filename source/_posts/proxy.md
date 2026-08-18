---
title: Proxy库的使用
date: 2025-01-02 19:51:00
toc: true
tags:
  - cpp
---
`proxy`库是微软推出的一个非继承式的多态实现。无论从性能来看还是侵入性来看，`proxy` 都是一个对api设计比较友好的库。
`proxy`在3.0版本中更新了使用方式，改进了之前写法过于难懂（丑）的问题。因此如果在业务中有需求的还是可以一试。
<!--more-->
# proxy的功能和优势

首先，微软的[proxy库](https://github.com/microsoft/proxy)主要希望解决两个问题：
- 通过非继承的方式实现多态。具体地说，c++的虚函数和go的duck type就是是否通过继承实现多态的两种方式。
- 更简化的对象生命周期管理方式。
因此如果你也受困于以下这几个问题，就可以考虑使用proxy来解决问题：
- 代码中使用了太多继承和虚函数，其中很多继承关系都是为了满足接口对抽象的要求
- 接口里`shared_ptr`满天飞，这些智能指针的目的是为了避免维护参数的生命周期
- 出于性能的考虑，对于高频调用的对象希望减少使用虚函数
# 如何在C++中使用`trait`
在rust中我们经常会给结构体添加一个属性宏，方便在debug的过程中打印结构体信息：
```Rust
#[derive(Debug)]
struct Person {     
    name: String,     
    age: u32, 
}
```
当然你也可以自己给结构体写一个Debug方法。此时你可以在一个泛型方法内使用它，而且所有满足`Debug`这个`trait`的函数都可以：
```Rust
fn requires_debug<T: Debug>(value: T) {
    println!("{:?}", value); 
}
```
这一点对于C++用户来说没有什么特殊的，也可以使用SFINAE技巧声明一个模板函数实现同样的事情（假设我们不关心编译时长，但是如果这是个常用接口，那么在大型项目里的编译耗时一般不会太短）：
```C++
template <typename T> 
using has_debug_t = decltype(std::declval<T>().Debug());
template <typename T> 
using has_debug = std::is_same<has_debug_t<T>, void>;
template <typename T> 
typename std::enable_if<has_debug<T>::value>::type call_debug(T& obj) {     
    obj.Debug(); 
}
```
但是对于Rust用户，还有一件事情是C++用户没法做的，可以保存一个泛型容器：
```Rust
let mut debug_container: Vec<Box<dyn Debug>> = Vec::new();
debug_container.push(Box::new(Person ));
```
> C++用户此时内心：啊？
> C++用户此时表面：伪需求

其实也有办法做，声明一个基类，基类具有Debug方法，之后所有的类都继承它即可：
```C++
class DebugAble {
    virtual void Debug() = 0;
}
std::vector<DebugAble*> vec {};
```
这种方法有几个缺陷：
- 所有的使用Debug方法的类都要继承`DebugAble`，侵入性很强
- 虚函数始终还是有开销的，尤其是和智能指针组合之后（内存碎片一大源头）
- 除了性能之外，因为有了虚表导致的代码bug也不少，最经典的就是对有虚表的类用`sizeof`和`memset`
- 并不是所有的类都是我们业务代码里定义的，例如第三方库和标准库中的一些结构体，我们没法改它的定义
# Proxy库使用
proxy在某种意义上可以解决这个问题，先看代码：
```C++
// 声明一个名为MemAt的convention，包含一个名为at的方法
PRO_DEF_MEM_DISPATCH(MemAt, at);
// 声明一个类型，这个类型是Convention的“实例化”
struct Dictionary : pro::facade_builder
    ::add_convention<MemAt, std::string(int)> // 这里约定at方法的模式是std::string(int)
    ::build {};

// 这里已经不是一个模板函数了 pro::proxy<Dictionary> 是一个具体的类型
// 所有有std::string at(int)方法的对象都可以隐式地转换成pro::proxy<Dictionary>
void PrintDictionary(pro::proxy<Dictionary> dictionary) {
    std::cout << dictionary->at(1) << "\n";
}

int main() {
    // 以下是具体的使用方式 很明白
    static std::map<int, std::string> container1{ {1, "hello"} };
    auto container2 = std::make_shared<std::vector<const char*>>();
    container2->push_back("hello");
    container2->push_back("world");
    PrintDictionary(&container1);  // Prints: "hello"
    PrintDictionary(container2);  // Prints: "world"
    return 0;
}
```
这里你不需要继承任何结构体，`std::map<int, std::string>*`和`std::shared_ptr<std::vector<const char*>>`都可以隐式转换为`pro::proxy<Dictionary>`，并且调用到`at`方法。有点**鸭子类型**的意思了。
此外这里要注意的是，`PrintDictionary`已经是个**具体的函数**了，而非一个模板函数。这和我们用模板去做一些元编程是不一样的，主要的区别就在于N个class调用M个方法，在编译期是实例化N * M还是N+M次的问题，在大型项目里还是很影响编译速度的。
根据proxy库的介绍，从2022年开始，这个库已经被应用在windows操作系统中，因此稳定性是有一定保障的。目前已经迭代到了3.0版本，整体代码的易读程度有了很大的提升。
## 项目使用方式
直接下载[proxy](https://github.com/microsoft/proxy)，并且在项目中引入头文件[proxy.h](https://github.com/microsoft/proxy/blob/main/proxy.h)即可。
需要注意的是，要求c++20。需要gcc 11.2或者clang 15.0.0或者msvc 19.30。
# proxy库的多态
在proxy中，一个“convention”（`MemAt`）可以被添加到一个抽象的对象（`Dictionary`）中，这样任意满足这个convention的对象都可以转换为抽象对象`Dictionary`的代理（proxy），即`pro::proxy<Dictionary>`。
从上例中可以发现，在proxy，我们是通过`std::map<int, std::string>`->`pro::proxy<Dictionary>`两层关系实现了多态，只是这种多态实现并不通过虚函数，也就无需声明继承关系。
除了成员方法的多态，我们还可以进行普通函数，操作符和转换的多态。以下是一些样例：
```C++
// 可以被invoke调用，且形参是void(int)的任意对象，都可以转换为proxy<Callable>
PRO_DEF_FREE_DISPATCH(CALL, std::invoke, call);
struct Callable : pro::facade_builder ::add_convention<CALL, void(int)>::build {};

// 可以被转换为double的对象都可以被转换为proxy<DoubleConvertible>
struct DoubleConvertible : pro::facade_builder
    ::add_convention<pro::conversion_dispatch<double>, double() const>
    ::build {};
    
// 实现了operator *= 和 << 的对象都可以被转换为proxy<Number>
struct Number : pro::facade_builder
    ::add_convention<pro::operator_dispatch<"*=">, void(int)>
    ::add_convention<pro::operator_dispatch<"<<", true>, std::ostream&(std::ostream&) const&>
    ::build {};
    
void foo(int b){
    std::cout << "foo! " << b << std::endl;
}

int main() {
    auto f = [](int b) {
      std::cout << "f! " << b << std::endl;
    };
    pro::proxy<Callable> p1 = &f;
    call(*p1, 1);
    pro::proxy<Callable> p2 = &foo;
    call(*p2, 42);
    
    pro::proxy<DoubleConvertible> p3 = pro::make_proxy<DoubleConvertible>(123);
    double d = static_cast<double>(*p3);
    // pro::proxy<DoubleConvertible> p999 = pro::make_proxy<DoubleConvertible>("123");
    // 这样肯定不行，因为"123"无论是string还是char*，都不能直接转double
    
    pro::proxy<Number> p4 = pro::make_proxy<Number>(std::numbers::pi);
    *p4 *= 3; // operator *=
    std::cout << *p4 << "\n"; // operator <<
}
```
可以看到，proxy对象的使用颇为类似指针。可以通过`->`调用对应方法，使用`*`进行解引用。例如最开始的例子里，以下两种方式都是可行的：
```C++
std::cout << dictionary->at(1) << "\n";
std::cout << （*dictionary).at(1) << "\n";
```
# proxy对象的常用操作
通常情况下，proxy对象的结构类似如下的形式：
```C++
class Proxy {
    std::byte ptr_[16]; // 这里的16是两倍void*的长度
}
```
因此可以理解proxy对象持有的数据是指向value的指针，所以正常情况下可以使用指针赋值，也可以使用智能指针：
```C++
double d = 3.14;
pro::proxy<Number> p1 = &d; // 取d的地址
pro::proxy<Number> p2 = std::make_shared<double>(3.14); // 智能指针
```
这里的区别就在于`ptr_`保存的内容是`double*`还是`shared_ptr<double>`。
此外，proxy对象之间也可以正常赋值：
```C++
double d = 3.14;
pro::proxy<Number> p1 = &d;
pro::proxy<Number> p2 = p1;
pro::proxy<Number> p3 = std::move(p2);
```
同时proxy对象也支持`std::ranges::swap`来交换对象：
```C++
double d1 = 3.14, d2 = 10.0;
pro::proxy<Number> p1 = &d1;
pro::proxy<Number> p2 = &d2;
std::ranges::swap(p1, p2);
```
proxy对象也可以通过赋null值来解除对原有值的引用，或者用reset也是一样的效果，同时我们也可以用`has_value()`检测proxy对象是否有值：
```C++
double d = 3.14;
pro::proxy<Number> p1;
std::cout << p1.has_value(); // false
p1 = &d;
std::cout << p1.has_value(); // true
p1 = nullptr;
p1.reset(); // 效果和上边一样
std::cout << p1.has_value(); // false
// 效果和has_value一样
std::cout << p1 != nullptr; // false
```
# proxy对象的生命周期
在之前的样例代码中，我们主要使用了持有指针的方式，实际上proxy对象也支持间接地持有一个值。此时的proxy对象类似一个unique_ptr：
```C++
// 任意支持平凡拷贝操作的对象的proxy
struct AnyCopyable : pro::facade_builder
    ::support_copy<pro::constraint_level::nontrivial>
    ::build {};

struct Foo {
  int payload[10000];
};

pro::proxy<AnyCopyable> p1 = pro::make_proxy<AnyCopyable>(Foo{}); // 持有值

auto *ptr = new Foo();
pro::proxy<AnyCopyable> p2 = ptr;
```
此时在`p1`销毁的时候也会附带销毁自身拥有的值，反之`p2`销毁的时候并不会触发`ptr`的销毁。
## proxy对象的赋值
再让我们回到proxy对象的赋值上。在proxy持有指针的情况下，赋值操作没有特别需要说明的，毕竟指针之间的互相拷贝也没什么特殊的。但是在proxy持有一个值的情况下，就会复杂一些：
```C++
pro::proxy<AnyCopyable> p1 = pro::make_proxy<AnyCopyable>(std::move(Foo{})); // p1持有值
pro::proxy<AnyCopyable> p2 = p1; // 复制一份Foo给p2
std::cout << p1.has_value(); // true
pro::proxy<AnyCopyable> p3 = std::move(p1); // 将p1的数据移动给p3
std::cout << p1.has_value(); // false
```
所以我们可以得出来一个简单的结论，当proxy持有指针的时候，他表现得像一个指针；当proxy持有一个值的时候，它表现得就像一个值。
这个结论在管理参数的生命周期时是十分有用的。
此外，在proxy中的生命周期管理是0开销的，在proxy对象拥有这个值（而不是指针）的情况下，在编译期选择的析构函数会调用对应值的析构，在持有指针的情况下则不额外处理。
## proxy的生命周期用于接口设计
在声明api的时候只需要声明接受的参数是对应的proxy，由**调用方决定**是否要将数据转移给proxy。如下代码所示：
```C++
void double_test(pro::proxy<DoubleConvertible> p) {
    std::cout << static_cast<double>(*p1) << "\n";
}

double d = 1;
// 将d的指针传给proxy，此时调用方需要负责生命周期
double_test(&d);
// 将d的所有权转移给proxy 此时proxy会在销毁时负责拥有数据的销毁 这样调用方不用管理数据的生命周期
double_test(pro::make_proxy<DoubleConvertible>(std::move(d))); 
// 用智能指针作为参数也可以
auto p = std::make_shared<double>(1);
double_test(p);
```
对比一下不使用proxy的情况下，我们应该如何声明一个接口：
```C++
void double_test(double &&d); // 这是调用方不负责生命周期的情况
void double_test(double* d); // 这是调用方负责生命周期的情况（也不一定）
void double_test(std::shared_ptr<double> d); // 这是调用方也不知道要不要负责生命周期的情况
```
相比于实现这三种方法，很多时候我们会选择第二种方法，并且在接口的注释里声明参数生命周期的处理方式（一般是调用方负责）。这种做法太依赖开发人员个人编程习惯，并不算是个好办法，事实上也是bug的高发地。
由于智能指针的传染性缘故，接口里引入它并不合适（更别说stl的abi不兼容引发的各种问题）。第三种方式虽然也很常见，但是是个很偷懒的方式。
综合来看，在设计接口的时候用proxy对象作为参数，确实能减少接口使用方的心智负担。
# 性能
在proxy2.0版本里，因为怪异的写法，在知乎上的讨论（骂战）里有这么一条评论
> “代码丑到这个样子，性能一定快到飞起吧！”

除了使用上的便利之外，性能肯定也是个考量。微软的团队为自己的库做了个[性能分析](https://devblogs.microsoft.com/cppblog/analyzing-the-performance-of-the-proxy-library/)：
两个结论：
- proxy的函数调用比虚函数的函数调用普遍快4%到260%，对象越小优化快的越多
- roxy的生命周期管理比智能指针普遍有几倍的提升（不考虑不用内存池的情况）。

第一个情况很好理解，因为虚表是跟着类走的，而proxy对象的meta信息（姑且算是虚表吧）是存在对象内部的。从缓存来看肯定是proxy要更优的。但是这个测试场景和正常业务使用差别还是挺大的。
第二个情况复杂一点，微软也没有给出进一步分析。但是在我看来首先对于小对象(正常是<=2 \* sizeof(void \* ))，proxy直接是存在了对象内，不申请额外的内存。另一方面也是因为proxy本身的内存分配器足够简单，性能比较强。
# 总结
本文介绍了一些微软proxy库的用法。综合来看，作为一个非继承多态的实现，本身的侵入性较小，在接口设计方面应该会挺有帮助，尤其是一些高频调用的接口。