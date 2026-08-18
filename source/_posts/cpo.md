---
title: ADL，CPO和tag_invoke
date: 2023-04-18 11:48:09
toc: true
tags:
  - cpp
---
在`executor`提案出现之后，有关于`cpo`和`tag_invoke`的话题就变得很常见。这几个功能，包括`ADL`都是为了解决在不同的`namespace`下如何正确的匹配到对应的方法的问题。

<!--more-->

# `ADL`实参依赖查找

考虑以下代码：

```cpp
#include <iostream>
namespace other {
	struct Bar;
	struct Foo {
		Bar* pBar; // 指向包含自己的Bar的地址
	};
	struct Bar {
		Foo foo;
	};
}
int main() {
	other::Bar bar1, bar2;
	bar1.foo.pBar = &bar1;
	bar2.foo.pBar = &bar2;
	std::swap(bar1, bar2); // 这里使用标准库的swap函数
	std::cout << "bar1 " << static_cast<void*>(&bar1) << " bar1.foo.pBar " << static_cast<void*>(bar1.foo.pBar) << std::endl;
	std::cout << "bar2 " << static_cast<void*>(&bar2) << " bar1.foo.pBar " << static_cast<void*>(bar2.foo.pBar) << std::endl;
	return 0;
}
```

很显然使用`std::swap`会破坏`Foo`的内在结构，都指向了错误的地址：

```shell
bar1 00AFFAA8 bar1.foo.pBar 00AFFA9C
bar2 00AFFA9C bar1.foo.pBar 00AFFAA8
```

因此我们需要额外写一个`swap`函数而不是使用标准库的实现：

```cpp
#include <iostream>
namespace other {
	struct Bar;
	struct Foo {
		Bar* pBar;
	};
	struct Bar {
		Foo foo;
        // 自行实现的swap函数
		friend void swap(Bar& lhs, Bar& rhs) {
			using std::swap;
			swap(lhs.foo, rhs.foo);
			lhs.foo.pBar = &lhs;
			rhs.foo.pBar = &rhs;
		}
	};
}
int main() {
	other::Bar bar1, bar2;
	bar1.foo.pBar = &bar1;
	bar2.foo.pBar = &bar2;
	swap(bar1, bar2); // 请注意 这里不再是std::swap 当然也无需声明other::swap
	std::cout << "bar1 " << static_cast<void*>(&bar1) << " bar1.foo.pBar " << static_cast<void*>(bar1.foo.pBar) << std::endl;
	std::cout << "bar2 " << static_cast<void*>(&bar2) << " bar1.foo.pBar " << static_cast<void*>(bar2.foo.pBar) << std::endl;
	return 0;
}
```

在代码中，我们无需声明`swap`来自`other`这个`namespace`，`ADL`规则允许编译器可以通过`Bar`所在的`namespace`，而无需额外声明。实际上，`swap`无需声明为`Bar`的友元函数一样能够顺利地查找到（但是这样就需要把成员都设置成`public`）。

我们可以看到，`ADL`是通过实参来查找相关的命名空间而无需额外声明，但是考虑一个问题，如果你是一个模板的作者，在你的库里实现了一个模版，其中会需要调用`swap`函数，你可能需要这么写：

```cpp
#include <iostream>
namespace other {
	struct Bar;
	struct Foo {
		Bar* pBar;
	};
	struct Bar {
		Foo foo;
		friend void swap(Bar& lhs, Bar& rhs) {
			using std::swap;
			swap(lhs.foo, rhs.foo);
			lhs.foo.pBar = &lhs;
			rhs.foo.pBar = &rhs;
		}
	};
}
namespace thirdlib {
	template<typename T>
	void DoSwap(T& lhs, T& rhs) {
		// 请注意这里显式使用了std
		using namespace std;
		swap(lhs, rhs);
	}
}
int main() {
	other::Bar bar1, bar2;
	bar1.foo.pBar = &bar1;
	bar2.foo.pBar = &bar2;
	thirdlib::DoSwap(bar1, bar2);
	std::cout << "bar1 " << static_cast<void*>(&bar1) << " bar1.foo.pBar " << static_cast<void*>(bar1.foo.pBar) << std::endl;
	std::cout << "bar2 " << static_cast<void*>(&bar2) << " bar1.foo.pBar " << static_cast<void*>(bar2.foo.pBar) << std::endl;
	int a = 1;
	int b = 2;
	thirdlib::DoSwap(a, b);
	std::cout << "a = " << a << std::endl;
	std::cout << "b = " << b << std::endl;
	return 0;
}
```

请注意`DoSwap`这个模版函数，如果没有`using namespace std;`，在调用`thirdlib::DoSwap(a, b)`时会报错。因为你找不到一个函数`swap`适配`int`类型的参数。

但是这么做虽然解决了匹配到不同函数调用的问题，但是作为库作者的心智负担就超大了：只要你的模板里使用到了标准库函数，就要开始思考会不会出现类似情况。所以我们开始思考，能不能我就使用`std::swap`呢，如果使用者能显示地声明自己要重载`std::swap`的实现，而编译器则能够根据声明的重载去查找对应的那个实现多好。

# `CPO` 定制点

> 计算机科学领域的任何问题都可以通过增加一个间接的中间层来解决

`cpo`通过增加一个中间层，将引入标准库这个操作集中起来，参考以下代码：

```c++
#include <iostream>
namespace other {
	struct Bar;

	struct Foo {
		Bar* pBar;
	};

	struct Bar {
		Foo foo;
		friend void swap(Bar& lhs, Bar& rhs) {
			using std::swap;
			swap(lhs.foo, rhs.foo);
			lhs.foo.pBar = &lhs;
			rhs.foo.pBar = &rhs;
		}
	};
}
namespace standard {
	struct swap_t {
		template<typename T>
		void operator()(T& lhs, T& rhs) const {
			// 我们不能直接修改标准库内容 这里模拟一下标准库的情况
			using std::swap;
			swap(lhs, rhs);
		}
	};
	// 这里的swap就是所谓的cpo
	inline swap_t swap{};
}
namespace thirdlib {
	template<typename T>
	void DoSwap(T& lhs, T& rhs) {
		// 第三方库在使用swap的时候无需考虑ADL的情况 直接使用即可
		standard::swap(lhs, rhs);
	}
}
int main() {
	other::Bar bar1, bar2;
	bar1.foo.pBar = &bar1;
	bar2.foo.pBar = &bar2;
	thirdlib::DoSwap(bar1, bar2);
	std::cout << "bar1 " << static_cast<void*>(&bar1) << " bar1.foo.pBar " << static_cast<void*>(bar1.foo.pBar) << std::endl;
	std::cout << "bar2 " << static_cast<void*>(&bar2) << " bar1.foo.pBar " << static_cast<void*>(bar2.foo.pBar) << std::endl;
	int a = 1;
	int b = 2;
	thirdlib::DoSwap(a, b);
	std::cout << "a = " << a << std::endl;
	std::cout << "b = " << b << std::endl;
	return 0;
}
```

这里我增加了一个`standard`来代表标准库的空间。这样在`thirdlib`的`DoSwap`中，我们总是可以直接调用`standard::swap`，不用考虑是否会有奇怪的结构体试图实现一个自己的`swap`。最终的调用路径会是`standard::swap->operator()->(ADL)->std::swap`或者`standard::swap->operator()->(ADL)->other::swap`。当然编译器最终会把这个中间步骤优化去除（假设是个正经编译器）。

此时事情看起来都挺圆满的了，但是我们注意到一个问题：凭什么标准库要假定`other::swap`是用来覆盖标准库的实现呢？说不定就有程序员使用了相同的函数签名但是无意覆盖`std::swap`呢，例如我的`swap`完全可能是把类里包含的数据从内存**swap**到硬盘（一脸嘴硬）。随着`executor`标准的出现，有很多`cpo`需要第三方库作者自己实现，这样就出现了标准库默认占用太多函数签名的情况了，例如`Scheduler`需要支持`schedule CPO`，`receiver`需要支持（我记不起来名字的）三个`CPO`等等。因此`tag_involke`就出现了，我们可以通过`tag_involke`显式声明我们写的这个`swap`就是用来`cpo`的：

# `tag_involke`

> 计算机科学领域的任何问题都可以通过增加一个间接的中间层来解决，again

我们之前的问题在于，标准库占用了太多函数名，不方便记，还容易踩坑。`tag_involke`让我们只需要记住一个定制点，并且显示声明自己要定制的函数，一个模拟的`tag_involke`简单实现可以如下图：

```c++
#include <iostream>

namespace standard {
	struct swap_t {
		template <typename T>
		void operator()(T& lhs, T& rhs) const noexcept {
			tag_invoke(swap_t{}, lhs, rhs);
		}
	};
	template <typename T>
    // 请注意 这里第一个参数使用swap_t 是真正标记cpo的地方
	void tag_invoke(swap_t, T& lhs, T& rhs) noexcept {
		std::swap(lhs, rhs);
	}
	inline swap_t swap{};
	
    // 这里声明辅助类tag_t用于帮忙恢复CPO的原始类型
	template<auto& Tag>
	using tag_t = std::decay_t<decltype(Tag)>;
}

namespace other {
	struct Bar;

	struct Foo {
		Bar* pBar;
	};

	struct Bar {
		Foo foo;
        // 这里声明定制的已经不是swap 而是tag_involke
        // 通过第一个参数标明这个tag_involke逻辑覆盖的是swap的逻辑
		friend void tag_invoke(standard::tag_t<standard::swap>, Bar& lhs, Bar& rhs) {
			std::swap(lhs.foo, rhs.foo);
			lhs.foo.pBar = &lhs;
			rhs.foo.pBar = &rhs;
		}
	};
}

namespace thirdlib {
	template<typename T>
	void DoSwap(T& lhs, T& rhs) {
		// 第三方库在使用swap的时候无需考虑ADL的情况 直接使用即可
		standard::swap(lhs, rhs);
	}
}

int main() {
	other::Bar bar1, bar2;
	bar1.foo.pBar = &bar1;
	bar2.foo.pBar = &bar2;
	thirdlib::DoSwap(bar1, bar2);
	std::cout << "bar1 " << static_cast<void*>(&bar1) << " bar1.foo.pBar " << static_cast<void*>(bar1.foo.pBar) << std::endl;
	std::cout << "bar2 " << static_cast<void*>(&bar2) << " bar1.foo.pBar " << static_cast<void*>(bar2.foo.pBar) << std::endl;
	int a = 1;
	int b = 2;
	thirdlib::DoSwap(a, b);
	std::cout << "a = " << a << std::endl;
	std::cout << "b = " << b << std::endl;
	return 0;
}
```

这里和`cpo`的唯一区别就在于，通过引入第一个参数的类型作为一个tag，使得`tag_involke`有能力区分最后的函数调用入口。在调用`standard::swap(lhs, rhs);`时，调用流程是`standard::swap->operator()->tag_involke()`，根据`ADL`规则查找到了`other::tag_invoke`是最佳匹配，而非实例化模版函数。

这里`standard::swap`用上去像是个函数，实际上是个对象，还能用`standard::tag_t<standard::swap>`用来声明`tag_involke`定制，看起来就像是声明定制函数一样。

举个例子来说，同样地，我们可以这样声明一个`swap2`方法：

```c++
namespace standard {
	struct swap2_t {
		template <typename T>
		void operator()(T& lhs, T& rhs) const noexcept {
			tag_invoke(swap_t{}, lhs, rhs);
		}
	};
	template <typename T>
    // 请注意 这里第一个参数使用swap_t 是真正标记cpo的地方
	void tag_invoke(swap2_t, T& lhs, T& rhs) noexcept {
		// 做点别的奇怪的事情
	}
	inline swap_t swap{};
}
```

这样在调用`standard::swap2`时，通过同样的调用链最终需要调用`tag_involke(swap2_t, Bar&, Bar&)`，虽然`other::tag_invoke`是同名函数，但是第一个形参不匹配（`swap2 vs swap`），所以最终还是会实例化`tag_invoke(swap2_t, Bar&, Bar&)`。

同理，即使这时候我们对`Bar`加了这样的实现，也不用担心`swap2`覆盖到了标准库的实现：

```c++
namespace other {
	struct Bar;

	struct Foo {
		Bar* pBar;
	};

	struct Bar {
		Foo foo;
     	// 这样声明的swap2并不会替换标准库的逻辑
        // 使用standard::swap2也不会调用进来
		friend void swap2(Bar& lhs, Bar& rhs) {
			std::swap(lhs.foo, rhs.foo);
			lhs.foo.pBar = &lhs;
			rhs.foo.pBar = &rhs;
		}
	};
}
```

在我看来好处有2：

- 标准库不用再占用一堆名字
- 我们写代码时不会莫名其妙地碰巧定制了一些定制点，毕竟也不太可能把所有`CPO`背下来。

# 总结

从`ADL`到`CPO`再到`tag_involke`，逐渐完善了对于标准库的行为定制，写法朝着更明确的方向前进。但是即使`tag_involke`也不是那么完美，考虑一段`rust`代码：

```rust
struct Point2D {
    x: f64,
    y: f64,
}
impl fmt::Debug for Point2D {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "Debug: Complex {{ x: {}, y: {} }}", self.x, self.y)
    }
}
```

定制了`Debug`输出的格式，意图清晰，写法也很简单，不容易误覆盖。希望`c++`也能见贤思齐，从语言规范和编译器特性上出发，少弄一些模板套模板的事情。
