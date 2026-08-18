---
title: lambda捕获变量在c++协程中的生命周期
date: 2024-04-12 22:55:00
toc: true
tags:
  - cpp
---
最近在实现一个基于`c++20`的协程库，当我把lambda和协程组合在一起用的时候，出现了capture变量失效的问题。最后发现是因为capture变量的生命周期的问题。
<!--more-->
<a id="section1"></a>
先上结论，在协程中，以下的lambda是有bug的：
```cpp
// generator是一个自定义协程类型
generator getCoroutine() {
	int a = 42;
	auto handler = [a]() -> generator{
		co_await something(); // 等待某个协程任务返回
		std::cout << a << std::endl; // 这里的a会不存在
	}
	return handler();
}
```
想要解决这个问题，可以修改一下实现：
```cpp
generator getCoroutine() {
	int a = 42;
	auto handler = [](int a) -> Cotask{
		co_await something(); // 等待某个协程任务返回
		std::cout << a << std::endl; // 这里a还是=42
	}
	return handler(a);
}
```
简单地说，原因是lambda捕获变量的生命周期不是协程维护的，而协程使用到的所有参数和栈变量的生命周期都是由c++维护在协程的帧中，因此不会出现过早释放的问题。
# coroutine的实现浅析
网上已经有挺多c++20协程的使用方式了，这里就不再详细描述，这里只简单解析一下协程对象的实现，参考以下协程函数（其中generator是协程结构体)：
```c++
generator fun()
{
    printf("Hello,");
    co_yield 4;
    printf("Wrold.\n");
    co_return 2;
}
```
在实际的运行中代码会被编译器展开如下的样子：
```cpp
/**
* 这个结构体用于保存协程执行过程中的上下文，包括栈变量，参数等
*/
struct __funFrame
{
  void (*resume_fn)(__funFrame *);
  void (*destroy_fn)(__funFrame *);
  std::__coroutine_traits_sfinae<generator>::promise_type __promise;
  int __suspend_index;
  bool __initial_await_suspend_called;
  std::suspend_always __suspend_62_11;
  std::suspend_always __suspend_66_5;
  std::suspend_always __suspend_62_11_1;
};
/**
* 注意展开后的fun中并没有原先的代码逻辑，而是创造了一个generator结构体，并且和执行真正逻辑的__funResume关联在一起
**/
generator fun()
{
  /* Allocate the frame including the promise */
  /* Note: The actual parameter new is __builtin_coro_size */
  __funFrame * __f = reinterpret_cast<__funFrame *>(operator new(sizeof(__funFrame)));
  __f->__suspend_index = 0;
  __f->__initial_await_suspend_called = false;
  
  /* Construct the promise. */
  new (&__f->__promise)std::__coroutine_traits_sfinae<generator>::promise_type{};
  
  /* Forward declare the resume and destroy function. */
  void __funResume(__funFrame * __f);
  void __funDestroy(__funFrame * __f);
  
  /* Assign the resume and destroy function pointers. */
  __f->resume_fn = &__funResume;
  __f->destroy_fn = &__funDestroy;
  
  /* Call the made up function with the coroutine body for initial suspend.
     This function will be called subsequently by coroutine_handle<>::resume()
     which calls __builtin_coro_resume(__handle_) */
  __funResume(__f);
  
  return __f->__promise.get_return_object();
}

/* This function invoked by coroutine_handle<>::resume() */
void __funResume(__funFrame * __f)
{
  try 
  {
    /* Create a switch to get to the correct resume point */
    switch(__f->__suspend_index) {
      case 0: break;
      case 1: goto __resume_fun_1;
      case 2: goto __resume_fun_2;
    }
    
     // 省略一堆代码
    
    __resume_fun_1:
     // 省略一堆代码
     // 主要执行逻辑 printf("Hello,"); co_yield 4;
    
    __resume_fun_2:
     // 省略一堆代码 printf("Wrold.\n");  co_return 2;
	}
	catch(...) {
		// ...
	}
  __final_suspend:
  // 省略一堆代码
  ;
}
```
出于篇幅考虑，上边的代码省略了许多细节，完整的可执行代码我放在[cppinsight](https://cppinsights.io/s/7f3b6d63)上，可以点击查看完成代码以及编译器展开后的样子。
从展开后的可以发现，我们原有的`fun()`的逻辑已经被替换成了生成`generator`这个协程结构体，而原有的逻辑则被移动到了`__funResume`中。我精简了`__funResume`的代码，可以发现这个函数的主要流程就是依赖一个`switch`，至此我们对于协程的原理就有了一个感性的认知：
1. 生成一个协程帧结构体`__funFrame`，用于存储协程在执行中的上下文
2. 生成一个用于执行协程真正逻辑的函数`__funResume`，每次协程唤醒的时候都执行这个逻辑
3. 将原有的协程函数`fun`逻辑替换成生成协程结构体`generator`，并且给它绑上`__funFrame`和`__funResume`，让`generator`知道每次`resume`都要调用什么函数，以及附带什么数据。

对于`__funcFrame`我们也可以发现，重入之后从上次的逻辑开始执行就是依赖`switch`实现的。每个`co_await`和`co_yield`都对应一个`switch`的label。每次协程暂停时都会在`__funFrame`的`__suspend_index`记录下次进来的label。
> 实际上cpp20的协程实现和作者在cpp17下利用`switch-case`做的协程原理类似，但是有编译器来做代码生成显然是好用得多，受限制的地方也少了很多
> 通过分析协程的实现，我们也大概能明白为啥cpp20的协程是stackless的（or反过来，因为要做stackless的才这么实现的）
# lambda的生命周期
我们在使用lambda的时候一直忽略的一个问题，就是lambda的捕获的变量是如何保存的？参考以下代码：
```cpp
struct Foo {
    int a{ 0 };
};

generator getAsyncTask() {
    auto tPtr = std::make_shared<Foo>(1);
    auto handler = [tPtr]() -> generator {
        for (int i = 1; i <= 5; ++i) {
            std::cout << i << " " << tPtr->a << std::endl;
            co_yield i;
        }
      	co_return 2;
    };
    return handler();
}
```
实际上`handler`会被展开成一个`class`，并且
类似以下代码：
```cpp
class __lambda_79_20
{
public:
	// 省略盲目多代码
	{
		// ...
	}
	// 实际上handler()调用的代码
	inline generator operator()() const { /* ... */ }
private:
    std::shared_ptr<Foo> tPtr;
public:
    __lambda_79_20(const std::shared_ptr<Foo> & _tPtr)
    : tPtr{_tPtr}
    {}
}
```
最终`getAsyncTask`的代码声明是类似如下代码
```cpp
generator getAsyncTask()
{
  std::shared_ptr<Foo> tPtr = std::make_shared<Foo>(1);
  class __lambda_79_20
  {
	  // 省略类内部定义
  }
  __lambda_79_20 handler = __lambda_79_20{tPtr};
  return handler.operator()();
  // 请注意，从这里出去之后handler的生命周期就结束了
}
```
> 相关代码也在上边的链接中，可以对比查看

至此我们就明白了为什么文章开头代码会有bug，因为对应的lambda结构体已经出了所在scope被释放了，对应的成员变量（即capture到的变量）也会被释放掉。
# 解决方案
文章开始给出了一个解决方案，就是换成带参数的lambda。但是作为一个协程库的作者（不然你应该也不用看这篇文章），提供的api大概率是接受一个满足对应约束的lambda并且返回协程对象。因此我们可以改成这样：
```cpp
template<typename F, typename... Args>
auto getTask(F&& lambda, Args... args) -> std::enable_if_t<std::is_invocable_r_v<generator, F, Args...>, generator> {
	// 粗略地避免F是一个有捕获变量的lambda，避免逻辑上出问题
	static_assert(std::is_empty_v<F>); 
    return lambda(std::forward<Args>(args)...);
}
```
这样你可以用如下方式调用：
```cpp
auto handler2 = [](int a) -> generator {
    for (int i = 1; i <= 5; ++i) {
        std::cout << i << " " << a << std::endl;
        co_yield i;
    }
    };
auto g3 = getTask(std::move(handler2), 1);
```
这是因为此时传入的a是保存在协程栈帧中（回忆一下`__funFrame`，会添加一个成员变量`a`），因此不会遇到生命周期的问题（跟着协程对象一起走）。
# 总结
本文分析了为何在有捕获的lambda中捕获变量丢失的问题。本质的原因就是lambda的实现和协程的实现各自为政，压根没有互相兼容的念头，导致了我们需要查看编译器展开代码才能分析出来这个问题。
类似我在{% post_link cpo CPO的分析 %}中提到的，c++委员会老是喜欢搞点这种用现有特性打补丁方式去实现新功能的做法，之后再让库作者买单。也可能是因为提案很多都来自知名库或者公司吧，但是人家是第三方库，你可是官方呀。
发完了牢骚，我只想说：
![柴犬表情：略略略|228](https://cdn.redhand.com.cn/img/20240413215532.png)