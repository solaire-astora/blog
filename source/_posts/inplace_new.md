---
title: c++使用placement new解决静态变量析构顺序问题
date: 2024-02-14 21:13:00
tags:
  - cpp
toc: true
---

在日常工作中，我们经常会遇到使用静态变量来保存唯一实例，例如著名的Meyer单例模式，可以在c++11的下不经过加锁就能实现线程安全的单例模式。但是静态变量如果在析构函数中也引用到了其他静态变量（最常见的就是`Logger`实例是一个静态变量时，在析构函数中记录了日志）。
本文中我们探讨了如何使用`placement new`绕开静态变量生命周期的问题。

<!-- more -->
# 静态变量生命周期
从一个样例代码开始：
```cpp
#include <iostream>

class Foo;
Foo* getFoo();

class Bar {
public:
    ~Bar() {
        auto pFoo = getFoo();
        std::cout << "destory bar" << std::endl;
    }
};

static Bar sBar;

class Foo {
public:
    ~Foo() {
        std::cout << "destory foo" << std::endl;
    }
};

static Foo sFoo;
Foo* getFoo() {
    return &sFoo;
}

int main() {
    return 0;
}
```
运行之后会输出
```bash
destory foo
destory bar
```
说明静态变量`sFoo`在`sBar`之前完成析构。此时如果调用`pFoo`的成员函数等可能会遇到无法预知的问题，取决于使用的编译器和平台。例如对于一个子类，笔者在`windows`+`msvc`上不会遇到异常，在`mac`+`clang`上会因为虚表被销毁的问题调用到不相关的类的方法。
无论如何，调用一个已经析构的类，即使不会出现内存访问问题（反正都是访问data segment），但是因为析构函数可能已经改变了类实例的状态，往往会出现难以定位的bug。
# 问题分析
[stackoverflow](https://stackoverflow.com/questions/68311272/how-to-delay-destruction-of-static-object-logger-in-c)上有类似的问题，通过讨论我们可以得到几个方法：
1. 规划静态变量的销毁顺序。静态变量的销毁顺序和它们声明的顺序相关，越早声明越晚销毁。但是这个顺序并不是`c++`的标准，依赖这样的逻辑很容易踩坑。而且当一个项目复杂度上升之后你会发现这几乎是做不到的。
2. 不要使用全局静态变量。全都使用函数静态变量可以解决这个问题。问题在于，对于一个大项目很难约束所有开发者都遵守这样的规定（使用静态代码检查也许是个办法）。
3. 直接new一个变量，反正程序结束之后都销毁了。这有点反人类，单纯从cr都会废很多口舌。正规的项目上用起来还是有点难以接受。
从上述几点来看没有特别稳定靠谱的。但是第三点给我们一个启示：是否可以找到一个像new一样不自动析构的方式，就能解决我们的问题了。
# placement new
先上placement new的样例：
```cpp
char* buff = new char[ sizeof(Foo) * N ];  
memset( buff, 0, sizeof(Foo)*N );
Foo* pfoo = new (buff)Foo;
```
简单来说，是我们自己分配内存，并且调用构造函数。一般情况下用于加快构建速度，也能反复使用分配好的内存避免内存碎片（写过对象池的小伙伴都说好）。
```cpp
#include <iostream>

class Foo;
Foo* getFoo();

class Bar {
public:
    ~Bar() {
        auto pFoo = getFoo();
        std::cout << "destory bar" << std::endl;
    }
};

static Bar sBar;

class Foo {
public:
    ~Foo() {
        std::cout << "destory foo" << std::endl;
    }
};

// 注意这里
char fooBuffer[sizeof(Foo)];
static Foo* sFoo = new(&fooBuffer) Foo();

Foo* getFoo() {
    return sFoo;
}

int main() {
    return 0;
}
```
运行后输出：
```
destory bar
```
因为是new出来的实例，所以不会自动调用析构函数。因此对于确实没什么资源要释放的对象来说也是个好方法。当然如果你确实有资源要释放，例如上一节stackoverflow链接里的logger，那么就需要仔细设计一下自己的逻辑了。
