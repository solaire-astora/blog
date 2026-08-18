---
title: c++的右值引用和完美转发
date: 2023-10-24 22:13:29
tags:
  - cpp
toc: true
---
右值引用，完美转发这些概念很多时候会让人弄不清楚概念。这篇文章中就让我们再来试图搞懂它们的区别和用法。
<!--more-->
# 右值和右值引用
首先说说右值，我们知道右值就是等号右边的值，并且**不能取地址**。单独拿出来这个概念可能很突兀，也不好理解，我们可以通过以下代码加深一下理解：
```c++
int* foo() {
	int a = 5;
	int *ret = &a; // 可以
	// int* ptr = &(1 + 2); // 不可以
	return ret; // 不可以
}
```
首先我们知道返回`a`的地址是错误的，因为`a`作为一个局部变量出了`foo`之后生命周期就结束了。因此`ret`指向的内存空间是没有什么意义的（即使`*ret`短时间内值保持不变）。
对于右值`(1+2)`来说，它的生命周期就存在于`int* ptr = &(1 + 2);`表达式中，执行完这个表达式`(1+2)`这个对象就需要销毁了。
因此`int* ptr = &(1 + 2);`本质上和返回函数中局部变量`a`的地址相同，是让指针指向一个即将销毁的对象的地址。因此索性在`c++`中就不允许取右值的地址。所以我们需要知道的是，**右值不能取地址是因为右值的生命周期只存在于表达式中，取了地址也没用意义**。
为了让右值的生命周期延长，诞生了**右值引用**（我们先不讨论为什么要让右值的生命周期延长）。这里请注意不要混淆引用和值的概念，**右值引用**和**右值**是两个类型，就如同`int*`和`int`也是两个不同的类型。所以我们会看到有种让人很懵圈的说法：“右值引用本身是左值”，看起来很绕，但是只要记住右值引用本身是一个类比指针的**新类型**即可。
我们可以通过以下代码加深理解右值引用对于如何延长右值的生命周期：
```c++
// 要运行这段代码请使用 g++ main.cpp -o main -fno-elide-constructors
// 否则因为NRVO会消除右值对象的移动构造的调用
#include <iostream>

class foo {
public:
    int x;
    foo(int x) {
        this->x = x;
    }
    ~foo() {
        std::cout << "Destructor called " << x << std::endl;
    }
};

int main() {
    foo a = foo(1); // 把右值对象复制了给了左值对象a
    // 在下边这句之前foo(1)右值对象已经销毁了
    // Destructor called 1
    std::cout << "flag1" << std::endl;
    foo&& b = foo(2);
    // 因为使用右值引用，foo(2)这个右值对象声明周期延长了
    std::cout << "flag2" << std::endl;
    // Destructor called 2 右值对象foo(2)销毁
    // Destructor called 1 左值对象foo(1)销毁
    return 0;
}
```
这里很显然因为右值引用`b`的关系使得`foo(2)`的生命周期变成了和`b`一样长（即到`main`函数结束）。当然单纯地延长右值的生命周期似乎意义不大，而因为`NRVO`的存在使得`foo a = foo(1)`优化之后也不比使用引用来得消耗更大。因此我们接下来探讨一下右值引用的意义。
# 移动构造函数
考虑以下代码：
```cpp
class MyString {
public:
    MyString(const char* str) {
        m_size = std::strlen(str);
        m_data = new char[m_size + 1];
        std::strcpy(m_data, str);
        std::cout << "Copy constructor called" << std::endl;
    }
    // 拷贝构造函数
    MyString(const MyString &other) {
        // 分配新内存并复制 other 的数据
        m_size = other.m_size;
        m_data = new char[m_size + 1];
        std::copy(other.m_data, other.m_data + m_size, m_data);
        m_data[m_size] = '\0';
    }
    ~MyString() {
        delete[] m_data;
    }
private:
    std::size_t m_size;
    char* m_data;
};
```
对于以下代码，必须要调用一次拷贝构造函数：
```cpp
MyString a = b; // 假设b也是MyString类型
```
这个逻辑是非常正常的，毕竟对于两个`MyString`都拥有各自的字符串数据，所以拷贝一次`m_data`是有必要的。但是考虑一种情况，如果`b`之后再也用不到了呢？例如`v.push_back(b)`这种情况，实际上完全可以不用拷贝`m_data`，直接把`m_data`**移动**到`v`的元素中。联想到右值的特点：右值的生命周期只在当前表达式生效。因此可以认为如果传入的是右值，就可以认为`m_data`之后不再需要，可以安全的**移动**给别的对象。
为此我们要解决两个问题：
1. 定义这种**移动**语义下的拷贝行为，即移动构造函数。
2. 赋予用户能够显式调用这种移动构造函数的能力，即`std::move`。
针对第一点很简单，我们修改一下`MyString`的代码：
```c++
class MyString {
public:
    MyString(const char* str) {
        m_size = std::strlen(str);
        m_data = new char[m_size + 1];
        std::strcpy(m_data, str);
        std::cout << "Copy constructor called" << std::endl;
    }
    // 拷贝构造函数
    MyString(const MyString &other) {
        // 分配新内存并复制 other 的数据
        m_size = other.m_size;
        m_data = new char[m_size + 1];
        std::copy(other.m_data, other.m_data + m_size, m_data);
        m_data[m_size] = '\0';
    }

    // 移动构造函数
    // 请注意这里的other就是一个右值引用 这样才能够延长右值的生命周期到函数内
    MyString(MyString &&other) {
        // "窃取" other 的资源
        m_data = other.m_data;
        m_size = other.m_size;

        // 将 other 置于有效但空状态
        other.m_data = nullptr;
        other.m_size = 0;
    }
    ~MyString() {
        delete[] m_data;
    }
private:
    std::size_t m_size;
    char* m_data;
};
```
针对第二点，我们要怎么使得移动构造函数生效呢？可以使用`std::move`，这个函数实际上是起到了一个类型转换的功能：将左值引用转换为右值引用。因此以下代码会调用到移动构造函数：
```c++
int main() {
    MyString str1("Hello, world!");
    // std::move(str1)返回一个右值引用
    MyString str2(std::move(str1)); // 调用移动构造函数
}
```
至此，我们大致弄明白了右值，右值引用和移动构造函数之间的关系。
# 万能引用和完美转发
回顾一下第一章我们说到的内容，“右值引用不是右值，而是一个类型”。要时刻弄清楚这个概念，“右值引用和左值引用不是同一个类型，即`int &&`和`int &`不是同一个类型”。
此时，对于下列模版函数，右值引用是无法匹配上的，因为没有匹配右值引用的版本：

```cpp
template <typename T>
void foo(T &arg) {
}
int main() {
    MyString str1("Hello, world!");
    foo(str1); // 可以匹配
    foo(std::move(str1)); // 无法匹配
}
```
此时可以稍作修改：
```cpp
template <typename T>
void foo(T &&arg) {
}
int main() {
    MyString str1("Hello, world!");
    foo(str1); // 可以匹配，此时 T= MyString &
    foo(std::move(str1)); // 可以匹配，此时T = MyString，是个正常的右值引用
}
```
因此参数形如`T &&arg`的可以称为**万能引用**，无论左值还是右值都能匹配。这里需要注意的就是左值版本下，`T`的类型被推导成`MyString &`，因此整个实例化函数形参是`foo(MyString & &&)`，根据引用折叠规则，`T& &&` 折叠为 `T&`，最终实例化后函数的形参是`foo(MyString&)`，即标准的左值引用。
此外，参考以下实现：
```cpp
void foo(T &&arg) {
    vector<T> v;
    v.emplace_back(arg);
}
```
此时，如果`arg`是左值，`emplace_back`会调用左值版本（这个没啥问题），但是如果传入的是右值，但是因为**右值引用类型也是左值**，所以还是会调用左值版本。为了能调用右值版本的`emplace_back`，我们可以这么修改：
```cpp
template <typename T>
void foo(T &&arg) {
    vector<T> v;
    v.emplace_back(std::forward<T>(arg));
}
int main() {
    MyString str1("Hello, world!");
    foo(str1);
    foo(std::move(str1));
}
```
在这里，`std::forward`就称之为**完美转发**，具体地，当实参是左值时候，它返回的是左值引用，也就是没做任何事；实参是右值的时候，它返回的是右值引用。
以下是`std::forward`的一个简要实现：
```cpp
template <typename T>
T&& forward(typename std::remove_reference<T>::type& arg) noexcept {
  return static_cast<T&&>(arg);
}
```
如果 `T` 是左值引用（例如 `T = SomeType &`），`std::forward<T>` 的返回类型将是 `T &&`，根据引用折叠规则，它将折叠为左值引用（例如 `SomeType &`）。
如果 `T` 是非引用类型（例如 `T = SomeType`），`std::forward<T>` 的返回类型将是 `T &&`，即右值引用（例如 `SomeType &&`）。
# auto&&
`auto&&` 是一种万能引用（universal reference），它可以绑定到任何类型的值（左值或右值）。`auto&&` 的逻辑基于 C++11 中的类型推导和引用折叠规则。
当使用 `auto&&` 作为变量类型时，编译器会根据所赋值的表达式来推导实际的类型。具体来说：
如果表达式是左值，那么 `auto` 将被推导为左值引用类型，例如 `SomeType&`。因此，`auto&&` 将变为 `SomeType& &&`。根据引用折叠规则，这将折叠为 `SomeType&`。
如果表达式是右值，那么 `auto` 将被推导为非引用类型，例如 `SomeType`。因此，`auto&&` 将保持为右值引用类型，例如 `SomeType&&`。
因此，`auto&&` 在for range的情况下十分好用，它允许我们以统一的方式处理左值和右值，同时避免不必要的拷贝。
# 总结
这篇文章中我们探讨了右值的生命周期和右值引用延长右值生命周期的特性；之后讨论了为了节省拷贝实现的移动构造函数以及相关的`std::move`；最后为了同时兼容左右值引用，探讨了万能引用和万能转发的实践。
总的来说，核心还是为了减少拷贝的开销，整出了这么些东西。相比之下，rust生命周期唯一的方式就省去了这些麻烦：)