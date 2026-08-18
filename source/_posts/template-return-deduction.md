---
title: c++泛型返回值类型推导
date: 2022-03-25 12:32:11
toc: true
tags:
  - cpp
  - template
---

# C++模板参数类型推导
在`c++`模板中，可以使用以下代码来根据类型推导来定制模板代码：

```c++
template<typename T>
void foo(T t) {
    // c++17之后生效，如果版本更旧可以换成std::is_integral<T>::value
    if constexpr (std::is_integral_v<T>) {
        // int 类型的特殊实现
    }
    else if constexpr (std::is_floating_point_v<T>) {
        // float double类型的特殊实现
    }
}
```

但是我们不能够根据返回值类型来特殊定制代码。

<!-- more -->

例如以下代码是行不通的：

```c++
template<typename T>
T foo() {
	T t;
    // c++17之后生效，如果版本更旧可以换成std::is_integral<T>::value
    if constexpr (std::is_integral_v<T>) {
        // int 类型的特殊实现
    }
    else if constexpr (std::is_floating_point_v<T>) {
        // float double类型的特殊实现
    }
    return t;
}
```

当然你可以这么写而不会报错，但是真正调用（实例化）的时候就不行了：

```c++
int a = foo();
double b = foo();
```

会显示

> 没有与参数列表匹配的 函数模板 "foo" 实例

仔细看报错的原因也很明显了：` T foo(void)` 无法推导 `T` 的模板参数。

# 问题分析

首先我们先复习一下不涉及到泛型时的`c++`函数，对于以下两个函数声明，实际上是无法通过编译的：

```c++
void foo();
int foo();
```

这点大家都很明确，返回值不同不是重载，因为它们的函数签名均为`foo_void`(实际上如果你用`objdump`去看符号表可能会是类似`_Z5foov`这种)。因此这两个函数在声明阶段就会编译不过了。

看到这里可能大家会想，“原来如此，难怪上边那段推导返回值的代码不会过。因为实例化之后函数签名相同，冲突了呀”。但是实际上看上一节的报错信息，并不是函数重定义之类的提示。实际上在函数模版中，返回值是函数签名的一部分：

> 1、普通函数的签名包括未修饰的函数名、参数类型列表、所在类或namespace名
>
> 2、成员函数的签名包括1+非成员函数的信息、cv 修饰符
>
> 3、函数模板的签名包括1+2+返回值类型和模板参数列表
>
> 4、函数模板的特化的签名包括1+2+3+匹配这个特化所对应的所有参数

所以显然，如果同时实例化了`int foo<int>()`和`double foo<double>()`也是丝毫没有问题的，因为它们的函数签名不同。只是问题出在了调用方的匹配上。因为对于编译器来说，编译器并没有把返回值作为一个参数来考虑，因此面对同样的`foo_void`这种形式的两个函数，编译器并不知道应该匹配到哪一个。

可能大家看到这里会疑惑：编译器是否太傻了？为什么不能把返回值同样作为重载匹配的一个考虑点。我们考虑以下代码：

```c++
template<typename T>
T foo() {
	T t;
    // c++17之后生效，如果版本更旧可以换成std::is_integral<T>::value
    if constexpr (std::is_integral_v<T>) {
        // int 类型的特殊实现
    }
    else if constexpr (std::is_floating_point_v<T>) {
        // float double类型的特殊实现
    }
    return t;
}
foo(); // 应该如何定义T?
```

很显然调用时该用什么参数实例化就很难决断了。当然，日后是否会出现当`double b = foo()`时编译器利用返回值去匹配实例化，那就不好说了。毕竟`rust`的泛型就可以这么做。

# 解决方法

说了那么多原因和分析，问题还得解决。而且这也不是屠龙技，对于例如反射之类的基础结构，如果能根据返回值定制逻辑，业务使用起来会方便很多。先放代码：

```c++
#include <string>
#include <type_traits>

struct ObjectValue {
	std::string str;
	int i;
	ObjectValue() : i(42), str("123") {}
};

class Converter {
private:
	ObjectValue& obj;
public:
    // 如果需要更多的参数 就增加类的成员变量即可
	Converter(ObjectValue& o) : obj(o) {}
	
	template<typename T>
	operator T ()&& {
		constexpr bool is_supported_type = std::is_integral_v<T> || std::is_same_v<T, std::string>;
		// 如果不支持就需要显示报错
		static_assert(is_supported_type, "must be int or string");

		if constexpr (std::is_integral_v<T>) {
			T t = obj.i;
			return t;
		}
		else if constexpr (std::is_same_v<T, std::string>) {
			T t = obj.str;
			return t;
		}
	}
};

int main() {
	ObjectValue v;
	int i = Converter(v);
	std::string str = Converter(v);
	// double f = Converter(v);
	return 0;
}
```

上述代码中，利用了一个`Converter`的强制类型转换运算符重载来解决这个问题。下边展开一下`int i = Converter(v);`

```c++
Converter c = Converter(v); // 使用v作为一个初始化的变量声明一个Converter
int i = c.operator int(); // 将converter转换成int
```

这里看上去像是函数调用，实际上只是声明了一个`Converter`类，并且将其转换成`int`类型。这样我们就把调用方的函数匹配的问题转换成了一个类型转换问题。我们看着像是传参的地方，实际上只是调用构造函数而已。

另外，为了避免复制开销，`Converter`的`obj`是一个引用类型，所以不能声明默认的构造函数。