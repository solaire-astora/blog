---
title: Proxy库分析之Convention
date: 2025-01-02 20:05:00
toc: true
tags:
  - cpp
---
> proxy库的使用请参考{% post_link proxy %}

本文聚焦`proxy`库的实现分析，分析了convention的实现。
<!--more-->
首先，我们从以下例子来看看proxy的convention的用法：
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

我们需要解决的问题就是，为什么`pro::proxy<Dictionary>`可以使用`->at`间接访问到`std::map<int, std::string>`的`at`方法。
# 手写一个Convention

为了简便，convention称为“约定”。和rust的trait差不多，可以认为就是对于含有方法的一个约定。

为了加深对于proxy库的理解，我们先思考一下，如果手动写，不考虑静态注册之类的信息，我们应该怎么手动定义一个convention？其实看起来是很简单的：

```C++
struct MemAtConvention {
    template<typename T>
    // 把传进来的指针保留下来
    MemAtConvention(T* ptr) {
        mPtr = (void*)ptr;
    }
    
    std::string at(int idx) {
        return (T*)mPtr->at(idx); // 完蛋，T应该是什么类型？
    }
    
    void *mPtr;
}
```

此时遇到一个问题，是因为我们无法确定`MemAtConvention`要如何在`at`方法的时候将`mPtr`转换成正确的类型。因为c++肯定是没法将类型保存成一个成员变量的。不过没关系，我们可以稍微绕一下：

```C++
struct MemAtConvention {
    template<typename T>
    // 把传进来的指针保留下来
    MemAtConvention(T* ptr) {
        mPtr = (void*)ptr;
        mAccessor = [this](int idx) {
            return (T*)mPtr->at(idx);
        }
    }
    
    std::string at(int idx) {
        return mAccessor(idx); // 直接调用mAccessor
    }
    
    void *mPtr;
    std::function<std::string(int)> mAccessor;
}
```

这就是类型擦除的一个做法了，使用lambda保存信息。在实际的使用中，我们也可以使用函数模板的方式来擦除T的信息，这样更省资源。

在知道了手写要怎么做的时候，我们就明白proxy库需要解决的几个问题：

- 自动为目标类添加特定的方法，例如`std::string at(int)`
- 处理从模板类型`T`向特定convention转换的问题（直接存void*指针就是个方法）
- 做好类型擦除，使得能够正确地调用到对应的方法

接下来，我们分别看看proxy库是怎么处理这些问题的。为了专注我们要研究的问题，**请注意以下几点**：

- 隐藏了所有c++20有关的concept，即requires部分，只专注模板的实现
- 和复制、引用相关的修饰符（例如&&, &）的处理，以及noexcept之类的修饰符处理都不考虑（因为比较简单）

本文的目标最终是找到这两点之间经过的路径：

:::diagram 01-goal
fig. 1 本文的目标：已知两端，求中间的路径
:::

# 给proxy自动添加at方法

在这一节中，我们首先需要搞明白为何`pro::proxy<Dictonary>`会被自动添加上一个`at`方法，即这张图的前半部分：

:::diagram 02-goal-first-half
fig. 2 本节聚焦前半段：at 方法从何而来
:::

在一切开始之前，先理清proxy中一些概念的定义
- `MemAt`是一个convention，它代表一种约定，`MemAt`这个约定是类包含`at`方法（但是形参和返回值未知）
- `Dictionary`是一个trait，它是一组convention的集合，并且会规定convention的形参。在当前场景下，`Dictionary`只有一个convention，就是包含一个`std::string at(int)`方法=
- `pro::proxy<Dictionary>`是一个proxy，它用一个trait作为模板参数，是proxy库中实现间接方法调用的基础，也是数据或者引用的存储对象。
以上三个对象，只有proxy最终会得到实例化，生成一个对象。
如果想快速了解，可以看看官方的sample里的`access_proxy.cpp`，能大致了解到都具体经历了哪些元编程阶段。
## 声明一个convention

如下所示，意思是声明一个名为`MemAt`的convention，包含一个名为`at`的方法。请注意，这里`at`是没有**具体的类型**的：
```C++
PRO_DEF_MEM_DISPATCH(MemAt, at);
```
宏展开之后会变成如下的代码：
```C++
struct MemAt {
    // 这里在最后我们会转回到这，实际上这里是最后实现类型擦除的部分
    template<class __T, class... __Args>
    decltype(auto) operator()(__T &&__self, __Args &&...__args) noexcept(noexcept(::std::forward<__T>(__self).at(::std::forward<__Args>(__args)...)))
    { 
        return ::std::forward<__T>(__self).at(::std::forward<__Args>(__args)...); 
    }
    
    // 第一种 accessor 的特化
    template<class __F, class __C, class... __Os>
    struct __declspec(empty_bases) accessor {
        accessor() = delete;
    };
    
    // 第二种 accessor 的特化
    template<class __F, class __C, class... __Os>
        requires(sizeof...(__Os) > 1u && (::std::is_trivial_v<accessor<__F, __C, __Os>> && ...))
    struct accessor<__F, __C, __Os...> : accessor<__F, __C, __Os>... {
        using accessor<__F, __C, __Os>::at...;
    };
    
    // 第三种 accessor 的特化
    template<class __F, class __C, class __R, class... __Args>
    struct accessor<__F, __C, __R(__Args...)> {
        // 注意一下 这里的at函数
        __R at(__Args... __args) { 
            return ::pro::proxy_invoke<__C>(::pro::access_proxy<__F>(*this), ::std::forward<__Args>(__args)...); 
        }
    };
    // 后边还很多，不写了
}
```
因此我们知道，`MemAt`是一个具体的类型，但是`MemAt::accessor`是一个**模板类**，后续我们可以为`MemAt::accessor`指定模板参数。进一步展开之前，我们可以先看下这段代码对比，先有个最基础的概念，`dictionary->at(1)`是怎么和`std::map<int, std::string>.at(1)`关联上的：
```C++
// 第三种 accessor 的特化
    template<class __F, class __C, class __R, class... __Args>
    struct accessor<__F, __C, __R(__Args...)> {
        // 注意一下 这里的at方法
        __R at(__Args... __args) { 
            return ::pro::proxy_invoke<__C>(::pro::access_proxy<__F>(*this), ::std::forward<__Args>(__args)...); 
        }
    };

struct Dictionary : pro::facade_builder
    ::add_convention<MemAt, std::string(int)> // 这里约定at方法的模式是std::string(int)
    ::build {};
```
可以对照，这里的`__R`和`__Args`对应的就是`std::string(int)`。最终，我们在`dictionary->at(1)`调用的其实是`MemAt::accessor<__F, __C, std::string(int)>::at`。
因此我们的图可以补全成：

:::diagram 03-accessor-at
fig. 3 揭晓 MemAt::accessor —— at 的真正实现处
:::

## 添加一个convention到trait
这里我们要明确`Dictionary`继承的是
`pro::facade_builder::add_convention<MemAt, std::string(int)>::build`这个类型。
**如果没耐心看这一节的分析，先上结论**：`Dictionary`的类型简略结构如下所示：

:::diagram 04-dictionary-type
fig. 4 Dictionary 继承 facade_impl，编译期组装 convention_types
:::

化简一下就是如下形式（因为是继承）
```C++
Dictionary::convention_types = std::tuple<conv_impl<false, MemAt, std::string(int)>>
```
正式开始分析，首先看看`pro::facade_builder`:
```C++
using facade_builder = basic_facade_builder<std::tuple<>, std::tuple<>,
    proxiable_ptr_constraints{
        .max_size = details::invalid_size,
        .max_align = details::invalid_size,
        .copyability = details::invalid_cl,
        .relocatability = details::invalid_cl,
        .destructibility = details::invalid_cl}>;
        
template <class Cs, class Rs, proxiable_ptr_constraints C>
struct basic_facade_builder {
    // ...
}
```
这里很显然`facade_builder`是一个空实现，这里`basic_facade_builder`的模板参数`Cs`代表了convention的列表，`RS`是反射的列表，`C`是约束。这里我们先只聚焦`Cs`。如前所述，第一步里，`Cs`是一个`std::tuple<>`，即空列表。
`basic_facade_builder`是组织所有convention的重要数据结构。
再来看看第二步`::add_convention<MemAt, std::string(int)>`，展开定义如下所示：
```C++
// 为了逻辑看起来清晰点，代码里忽略了所有的requires
template <class D, class... Os>
// 直接调用add_indirect_convention
using add_convention = add_indirect_convention<D, Os...>;

template <class D, class... Os>
using add_indirect_convention = basic_facade_builder<details::add_conv_t<
    Cs, details::conv_impl<false, D, Os...>>, Rs, C>;
// details::add_conv_t 做的工作就是把 std::tuple<A, B>, C 转换成std::tuple<A, B，C>
// 具体实现可以看看源码
```
这里的`D`就是`MemAt`，`...Os`就是`std::string(int)`。可以看到，`add_indirect_convention`又变成了`basic_facade_builder`，只是`Cs`部分有所变化了。将元编程转换为伪代码执行，直观地看是这样:
```C++
// 第一步，声明一个初始类型，约束列表Cs是空
pro::facade_builder = basic_facade_builder<std::tuple<>, std::tuple<>, C>;
// 第二步，Cs添加一个新的约束
auto tuple = std::tuple<details::conv_impl<false, MemAt, std::string(int)>>;
// 第三部，用新的Cs列表生成一个新的类型
auto new_type = basic_facade_builder<{details::conv_impl<false, MemAt, std::string(int)>}, std::tuple<>, C>;
```
因此，`add_convention`调用过后，当前的类型从`basic_facade_builder<std::tuple<>, std::tuple<>, C>`变化为了`basic_facade_builder<std::tuple<Cs1>, std::tuple<>, C>`。新增加了一个convention。
> 这里假设`Cs1=details::conv_impl<false, MemAt, std::string(int)>`

如果再调用一次`add_convention`增加convention，那么类型就会变化成`basic_facade_builder<std::tuple<Cs1, Cs2>, std::tuple<>, C>`。
之后我们再查看`details::conv_impl`的实现，请注意`conv_impl::accessor`的实现：
```C++
template <bool IS_DIRECT, class D, class... Os>
struct conv_impl {
  static constexpr bool is_direct = IS_DIRECT;
  using dispatch_type = D;
  using overload_types = std::tuple<Os...>;
  template <class F>
  // 注意这里
  using accessor = typename D::template accessor<F, conv_impl, Os...>;
};
```
`IS_DIRECT`是访问接口的方式，就是`p->at(1)`和`p.at(1)`的区别，在我们的case里这个是false，即间接调用（指针类型的就叫间接调用）。`D`是`MemAt`,`...Os`是`std::string(int)`。整体结构很简单，回忆一下一开始的宏：
```C++
// 第三种 accessor 的特化
    template<class __F, class __C, class __R, class... __Args>
    struct accessor<__F, __C, __R(__Args...)> {
        // 注意一下 这里的at函数
        __R at(__Args... __args) { 
            return ::pro::proxy_invoke<__C>(::pro::access_proxy<__F>(*this), ::std::forward<__Args>(__args)...); 
        }
    };
```
来到了这里，`at`方法就被偏特化了：

```C++
template <class F>
conv_impl<false, MemAt, std::string, int>::accessor 
    = MemAt::accessor<F, conv_impl, std::string(int)>;
```
最后看一下`::build`的实现：

```C++
using build = details::facade_impl<Cs, Rs, details::normalize(C)>;

template <class Cs, class Rs, proxiable_ptr_constraints C>
struct facade_impl {
  using convention_types = Cs;
  using reflection_types = Rs;
  static constexpr proxiable_ptr_constraints constraints = C;
};

// convention_types = std::tuple<conv_impl<false，MemAt, std::string(int)>>;
```

这一步比较简单，就是将convention列表存到`convention_types`中。此外，通过`details::normalize`合并一些meta信息（目前暂时不重要）：

```C++
constraints.max_size 就是proxy里存储对象的最大长度，一般情况下就是2 * sizeof(void*)=16
constraints.copyability 复制构造函数的属性（nontrivial, nothrow...）
constraints.relocatability 移动构造函数的属性（nontrivial, nothrow...）
constraints.destructibility 析构函数的属性（nontrivial, nothrow...）
```

因此对于这份代码，我们可以做一个简单的展开：

```C++
// 其中
using Cs = conv_impl<false，MemAt, std::string(int)>;

struct Dictionary : pro::facade_builder
    ::add_convention<MemAt, std::string(int)> // 这里约定at方法的模式是std::string(int)
    ::build {};
// 等价于
struct Dictionary : details::facade_impl<std::tuple<Cs>, std::tuple<>, C>
```

绕了一大圈，其实就是为了编译期时组装`Dictionary::convention_types`成为`std::tuple<conv_impl<false, MemAt, std::string(int)>>`。

如果你调用多组`add_convention`，最终`Dictionary::convention_types`会变成一个很长的std::tuple。这里tuple类似运行期的std::vector，包含了我们添加的所有convention信息，只不过是以元编程的方式。

**每添加一个convention，`Dictionary`的类型都是变化的。**
## 将trait和proxy绑定在一起

`Dictionary`只是一个类型，只是通过元编程的方法增加了一些方法，为了能够正常地调用到对应方法和管理值的生命周期，需要额外声明一个`proxy`类，我们希望知道最终`proxy<Dictionary>`是什么样的，为什么能够调用`at`方法。

直接上结论，`proxy<Dictionary>`是通过内部的成员获得`at`方法的：

:::diagram 05-proxy-members
fig. 5 proxy 通过成员 ia_ 获得 at 方法
:::

展开看看`pro::proxy`的实现，主要就是关注两个operator重载，以及成员变量`_ia`。

```C++
// 在我们的例子里，F=Dictionary
template <class F>
class proxy : public details::facade_traits<F>::direct_accessor {
    auto operator->() { return std::addressof(ia_); }
    auto& operator*() & { return ia_; }

    using _Traits = details::facade_traits<F>;
    typename _Traits::indirect_accessor ia_; // 重点
}
```

这里我们通过proxy重载了`->`和`*`运算符可以发现，实际上`proxy->at(1)`调用的是`ia_.at(1)`，这是智能指针里的常用操作了。接下来我们要搞清楚`ia_`是如何继承到`at`方法的。

再展开一下`_Traits= details::facade_traits<Dictionary>`：

```C++
template <class F = Dictionary>
struct facade_traits: instantiated_t<facade_conv_traits_impl, typename Dictionary::convention_types, Dictionary> {
    // ...
}
```

先搞明白`instantiated_t`的作用，看看`details::facade_traits<Dictionary>`继承了什么，假设有如下代码：

```C++
template<class... Types>
struct MyTemplate {};

using MyTuple = std::tuple<int, double, char>;
```

使用的结果就是如下效果，相当于把第一个参数当做模板类（`MyTemplate`），第三个参数(float)作为第一个模板参数，第二个参数一定是一个tuple（`MyTuple`），把tuple的参数展开作为剩余的模板参数

```C++
using Result = instantiated_t<MyTemplate, MyTuple, float>;
// 等价于 Result = MyTemplate<float, int, double, char>
```

之前我们的推导中得到了`Dictionary::convention_types`=`std::tuple<conv_impl<false, MemAt, std::string(int)>>`（参考上一节高亮部分），因此代入一下可以得到：

```C++
struct facade_traits : public facade_conv_traits_impl<Dictionary, conv_impl<false, MemAt, std::string(int)>> {
    // 
}
```

进一步看看`facade_conv_traits_impl<Dictionary, conv_impl<false, MemAt, std::string(int)>>`都做了啥：

```C++
template <class F, class... Cs>
struct facade_conv_traits_impl<F, Cs...> : applicable_traits {
  using conv_meta = composite_meta<typename conv_traits<Cs>::meta...>;
  // 看这里，这就是ia_的类型
  using indirect_accessor = composite_accessor<false, F, Cs...>;
  using direct_accessor = composite_accessor<true, F, Cs...>;

  template <class P>
  static constexpr bool conv_applicable_ptr =
      (conv_traits<Cs>::template applicable_ptr<P> && ...);
};
```

把`F=Dictionary, Cs=conv_impl<false, MemAt, std::string(int)>`代入进去，我们得到了`ia_`的类型：

```C++
typename _Traits::indirect_accessor ia_;
using _Traits = details::facade_traits<Dictionary>;

// 这就是ia_的类型
using details::facade_traits<Dictionary>::indirect_accessor 
    = composite_accessor<false, Dictionary, conv_impl<false, MemAt, std::string(int)>;
```

很显然，重点就在于`composite_accessor`的实现：

```C++
template <bool IS_DIRECT, class F, class... Cs>
using composite_accessor = recursive_reduction_t<
      composite_accessor_helper<IS_DIRECT, F>::template reduction_t,
      composite_accessor_impl<>, Cs...>;
```

和之前的`basic_facade_builder`定义十分相似，但凡看到`composite_accessor_impl<>`这类的，就知道目的就是要将`composite_accessor_impl<>`扩充成`composite_accessor_impl<A, B, C...>`。

首先对于`recursive_reduction_t`，功能是将`recursive_reduction_t<R, O, A, B, C>`翻译成

`R<R<R<O, A>, B, C>`。

展开之后可以得到`ia_`的类型

```C++
composite_accessor_helper<false, Dictionary>::
    reduction_t<composite_accessor_impl<>, conv_impl<false, MemAt, std::string(int)>>;
```

其次来看`composite_accessor_helper`，这里的重点在于`composite_accessor_reduction`的展开：

```C++
// 这里 F = Dictionary
template <bool IS_DIRECT, class F>
struct composite_accessor_helper {
  // 这就是用来获得之前details::conv_impl的accessor
  template <class C> requires(C::is_direct == IS_DIRECT)
  using single_accessor = typename C::template accessor<F>;
  // single_accessor = typename C::template accessor<Dictionary>
  
  // 这里O=composite_accessor_impl<>， I= conv_impl<false, MemAt, std::string, int> 
  template <class O, class I>
  using reduction_t =
      typename composite_accessor_reduction<single_accessor, O, I>::type;
};

// 这里TA = single_accessor，...As = [] （注意下边 composite_accessor_impl<As...>）
// I = conv_impl<false, MemAt, std::string, int>
template <template <class> class TA, class... As, class I>
struct composite_accessor_reduction<TA, composite_accessor_impl<As...>, I>
    { using type = composite_accessor_impl<As..., TA<I>>; };
    
```

这里分两步展开，先处理`single_accessor`的定义：

```C++
single_accessor<conv_impl<false, MemAt, std::string(int)>><Dictionary>
     = conv_impl<false, MemAt, std::string(int)>::accessor<Dictionary>
     = MemAt::accessor<F, conv_impl, std::string(int)><Dictionary>
     = MemAt::accessor<Dictionary, conv_impl, std::string(int)>
```

之后得到`composite_accessor_helper<false,Dictionary>::reduction_t`:

```C++
// 为了方便后续书写
using CONV_IMPL = conv_impl<false, MemAt, std::string(int)>

// 因此我们可以得到ia_的类型
reduction_t = composite_accessor_impl<MemAt::accessor<Dictionary, CONV_IMPL, std::string(int)>>
```

再展开`composite_accessor_impl`就能发现最终的结构了：

```C++
template <class... As>
// 最终传入的模板参数都会变成它的父类
class composite_accessor_impl : public As... {
  template <class> friend class pro::proxy;

  composite_accessor_impl() noexcept = default;
  composite_accessor_impl(const composite_accessor_impl&) noexcept = default;
  composite_accessor_impl& operator=(const composite_accessor_impl&) noexcept
      = default;
};

// 最终出现了这么一个结构体，这也是ia_的类型
class composite_accessor_impl : 
    public MemAt::accessor<Dictionary, CONV_IMPL, std::string(int)>;
```

最后我们再来总结一下，`pro::proxy<Dictionary>::ia_`是如何继承`MemAt::accessor<F, CONV_IMPL, std::string(int)>`的：

1. 类型为 `details::facade_traits<Dictionary>::indirect_accessor`
    
2. `facade_traits<Dictionary>`通过`composite_accessor`将`Dictionary`的convention列表`Dictionary::convention_types`转换成多继承结构，间接让`indirect_accessor`继承了`MemAt::accessor<Dictionary, CONV_IMPL, std::string(int)>`。
    

所以我们可以想到，一开始如果我们多调用几次`add_convention`，最后就要让`pro::proxy<Dictionary>`多继承几个`accessor`。

`MemAt::accessor<Dictionary, CONV_IMPL, std::string(int)>`的实例化长这样：

```C++
//template<Dictionary, CONV_IMPL, std::string, int>
struct accessor<Dictionary, CONV_IMPL, std::string(int)> {
    std::string at(int idx) { 
        return ::pro::proxy_invoke<CONV_IMPL>(::pro::access_proxy<Dictionary>(*this), idx); 
    }
};
```

既然我们的`pro::proxy<Dictionary>::ia_`间接继承到了`MemAt::accessor<Dictionary, CONV_IMPL, std::string(int)>`，那自然是可以调用`dictionary->at(1)`。

截至到目前为止，我们自动给`proxy`添加上了`at`方法。
# 数据存储

接下来，我们开始考虑，如何将任意满足要求的类型T，存储到`proxy`中，看看会保存什么东西下来。

## 数据存储

首先，我们再检查`proxy`的实现，在`PrintDictionary(&container1);`的前提下，`P=std::map<int, std::string>`**`*`**。请注意，此时`P`是一个指针类型：

```C++
template <class F>
class proxy : public details::facade_traits<F>::direct_accessor {
    using _Traits = details::facade_traits<F>;
    // ...
public:
    // 从传入的指针构造proxy
    // P = std::map<int, std::string>*
    template <class P>
    proxy(P&& ptr) noexcept(std::is_nothrow_constructible_v<std::decay_t<P>, P>)
    { initialize<std::decay_t<P>>(std::forward<P>(ptr)); }
private:
    template <class P, class... Args>
    P& initialize(Args&&... args) {
      // 拷贝指针到ptr_里
      std::construct_at(reinterpret_cast<P*>(ptr_), std::forward<Args>(args)...);
      // 保存meta信息
      meta_ = details::meta_ptr<typename _Traits::meta>{std::in_place_type<P>};
      // 这句用来保证原地构造ptr_不会被编译器优化掉，理解成reinterpret_cast<P*>(ptr_)就行
      return *std::launder(reinterpret_cast<P*>(ptr_));
    }
private:
    [[___PRO_NO_UNIQUE_ADDRESS_ATTRIBUTE]]
    typename _Traits::indirect_accessor ia_;
    details::meta_ptr<typename _Traits::meta> meta_;
    alignas(F::constraints.max_align) std::byte ptr_[F::constraints.max_size];
};
// 这里的max_size由以下代码：
struct Dictionary : pro::facade_builder
    ::add_convention<MemAt, std::string(int)>
    ::build {};
// 这里的build方法得到  
```

这里`F::constraints.max_size`在64位的机器上是16字节。感兴趣的可以看看`details::normalize`的实现。16字节足以容纳指针和智能指针了。

有关于`ptr_`这里就没有更多的秘密了，就是存个指针。

## Meta信息存储

### `_Traits::meta`的分析

接下来关注`meta_`的结构。meta信息一般情况下是用来描述一个类型的基础信息，例如要如何构造，如何析构。这里`_Traits::meta`比较重要的结构是存储了convention的meta信息。

首先关注`_Traits::meta`结构体，`details::facade_traits`我们是第二次分析了：

```C++
using _Traits = details::facade_traits<F>; // F = Dictionary
struct facade_traits<F>
    // 底下这两段是之前用来存储convention的信息的
    : instantiated_t<facade_conv_traits_impl, typename F::convention_types, F>,
      instantiated_t<facade_refl_traits_impl, typename F::reflection_types, F> {
  // 复制操作的约束级别 最后是 relocatability_meta_provider<true>
  using copyability_meta = lifetime_meta_t<
      copyability_meta_provider, F::constraints.copyability>; // pro::constraint_level::none
  // 类似，最后是relocatability_meta_provider<true>
  using relocatability_meta = lifetime_meta_t<
      relocatability_meta_provider,
      F::constraints.copyability == constraint_level::trivial ?
          constraint_level::trivial : F::constraints.relocatability>;
  // 类似，最后是 destructibility_meta_provider<true>
  using destructibility_meta = lifetime_meta_t<
      destructibility_meta_provider, F::constraints.destructibility>;
  
  // 重点，将所有的meta信息都组合起来
  using meta = composite_meta<copyability_meta, relocatability_meta,
      destructibility_meta, typename facade_traits::conv_meta,
      typename facade_traits::refl_meta>;
  static constexpr bool has_indirection = !std::is_same_v<
      typename facade_traits::indirect_accessor, composite_accessor_impl<>>;
};

template <class... Ms>
using composite_meta =
    recursive_reduction_t<meta_reduction_t, composite_meta_impl<>, Ms...>;
```

关于复制操作的约束级别我们目前可以不用考虑，重点关注`meta`。可以看到最终`meta`也是调用到了`recursive_reduction_t`，这个之前我们分析过用法，最终`meta`的类型类似：

```C++
using _Traits::meta = 
// 注意，继承了facade_traits::conv_meta
struct composite_meta_impl : facade_traits::conv_meta, { 
  constexpr composite_meta_impl() noexcept = default;
  template <class P>
  constexpr explicit composite_meta_impl(std::in_place_type_t<P>) noexcept
      : Ms(std::in_place_type<P>)... {}
};
```

这里重点看`facade_traits::conv_meta`：

```C++
// 这里我们之前也分析过了一次
// 这里F = Dictionary Cs = conv_impl<false, MemAt, std::string(int)>
// 有点懵的可以倒回去看看
struct facade_conv_traits_impl<F, Cs...> : applicable_traits {
  using conv_meta = composite_meta<typename conv_traits<Cs>::meta...>;
  // ...
}

struct conv_traits<C>
    : instantiated_t<conv_traits_impl, typename C::overload_types, C> {};
    
// 因此是有
using facade_traits::conv_meta = 
    struct composite_meta_impl : conv_traits<conv_impl<false, MemAt, std::string(int)>>::meta {}
```

再回顾一下`CONV_IMPL`的定义：

```C++
CONV_IMPL = conv_impl<false, MemAt, std::string(int)>
// 因此
using facade_traits::conv_meta = struct composite_meta_impl : conv_traits<CONV_IMPL>::meta {}
```

此时展开一下`conv_traits`，我们需要获得`conv_traits::meta`:

```C++
template <class C>
struct conv_traits<C>
    : instantiated_t<conv_traits_impl, typename C::overload_types, C> {};
// C = CONV_IMPL
// 替换之后得到
struct conv_traits<CONV_IMPL> 
    : instantiated_t<conv_traits_impl, std::tuple<std::string(int)>, CONV_IMPL>
// 展开instantiated_t得到
struct conv_traits<CONV_IMPL> : conv_traits_impl<CONV_IMPL, std::string(int)>
// 因此
using facade_traits::conv_meta = 
    struct composite_meta_impl : conv_traits_impl<CONV_IMPL, std::string(int)> {}
```

接下来看看`conv_traits_impl`干了什么，这里的重点还是`conv_traits_impl::meta`：

```C++

template <class C = CONV_IMPL, class... Os = std::string(int)>
struct conv_traits_impl<C, Os...> : applicable_traits {
  // ...
  using meta = composite_meta_impl<dispatcher_meta<typename overload_traits<Os>
      ::template meta_provider<C::is_direct, typename C::dispatch_type>>...>;
  // ...
};
```

这里`composite_meta_impl`我们暂时不展开。

是在我们的case里，`Os = std::string(int)`，因此这里的模板参数`R = std::string, args = int`，`C = CONV_IMPL`，因此`C::is_direct=false, C::dispatch_type=MemAt`，可以回顾一下最开始convention声明部分的讲解，展开之后得到：

```C++
dispatcher_meta<overload_traits<std::string(int)> ::meta_provider<false, MemAt>>>
```

这里的先处理`overload_traits<std::string(int)>::meta_provider<false, MemAt>>`，它是用来提取重载函数信息的。

```C++
// R = std::string, args = int
template <class R, class... Args>
struct overload_traits<R(Args...)>
    : overload_traits_impl<qualifier_type::lv, false, R, Args...> {};
template <class R, class... Args>
struct overload_traits<R(Args...) noexcept>
    : overload_traits_impl<qualifier_type::lv, true, R, Args...> {};
// .... 还有很多，不一一列出

// Q = qualifier_type::lv
// NE 是否没有except
// R = std::string, args = int
// IS_DIRECT = false
template <qualifier_type Q, bool NE, class R, class... Args>
struct overload_traits_impl : applicable_traits {
  template <bool IS_DIRECT, class D>
  struct meta_provider {
    template <class P>
    // 这个get很有用
    static constexpr auto get()
        -> func_ptr_t<NE, R, add_qualifier_t<std::byte, Q>, Args...> {
        return &indirect_conv_dispatcher<D, P, Q, R, Args...>;
      // ....
    }
  };
  struct resolver {
    overload_traits_impl operator()(add_qualifier_t<std::byte, Q>, Args...);
  };
  // ...
};
```

这个类型总算没有继续套娃了。我们发现这里有两个比较重要的成员，`meta_provider`和`resolver`。其中，这个`meta_provider`十分重要，是我们之后类型擦除的重要部分。而`resolver`只是用来让`resolver()`可以返回一个`overload_traits_impl`，方便`std::invoke_result_t`获取类型罢了。

因此`overload_traits<std::string(int)>::meta_provider<false, MemAt>>`可以稍微转换一下得到

`overload_traits_impl<qualifier_type::lv, false, std::string, int>::meta_provider<false, MemAt>`，我们用`MP`来指代。

最后一步，我们再展开一下`conv_traits_impl::meta`，会得到：

```C++
using conv_traits_impl::meta =
    // MP = overload_traits_impl<qualifier_type::lv, false, std::string, int>::meta_provider<false, MemAt>
    template <class MP> 
    struct dispatcher_meta {
        constexpr dispatcher_meta() noexcept : dispatcher(nullptr) {}
        template <class P>
        constexpr explicit dispatcher_meta(std::in_place_type_t<P>) noexcept
            : dispatcher(MP::template get<P>()) {}

        decltype(MP::template get<void>()) dispatcher; // 这个以后有大用
    }
```

最后得到`_Traits::meta`的大致结构（抹掉其他继承内容）：

```C++
using MP = overload_traits_impl<qualifier_type::lv, false, std::string, int>::meta_provider<false, MemAt>
struct composite_meta_impl : dispatcher_meta<MP> {
  constexpr composite_meta_impl() noexcept = default;
  template <class P>
  constexpr explicit composite_meta_impl(std::in_place_type_t<P>) noexcept
      : Ms(std::in_place_type<P>)... {}
};
```

中间比较绕，代码太复杂不看没关系，重点记住这个结论就好。其实核心就是通过不停继承组合meta信息罢了。

### `details::meta_ptr`的存储

回到`proxy::meta_`定义：

```C++
template <class F>
class proxy  {
    using _Traits = details::facade_traits<F>;
private:
    template <class P, class... Args>
    P& initialize(Args&&... args) {
      // 保存meta信息
      // 请注意，这里是用P作为初始化函数的方法
      meta_ = details::meta_ptr<typename _Traits::meta>{std::in_place_type<P>};
    }
    // ...
private:
    details::meta_ptr<typename _Traits::meta> meta_;
};

// 以下的 M 全都是_Traits::meta
template <class M>
using meta_ptr = typename meta_ptr_traits<M>::type;

template <class M>
struct meta_ptr_traits : std::type_identity<meta_ptr_indirect_impl<M>> {};

template <class M>
struct meta_ptr_indirect_impl {
  constexpr meta_ptr_indirect_impl() noexcept : ptr_(nullptr) {};
  
  // 这里P是传入的std::in_place_type<P>
  template <class P>
  constexpr explicit meta_ptr_indirect_impl(std::in_place_type_t<P>) noexcept
      // 请注意，这里M（即_Traits::meta)也是用类型P初始化的
      : ptr_(&storage<P>) {}
  bool has_value() const noexcept { return ptr_ != nullptr; }
  void reset() noexcept { ptr_ = nullptr; }
  // 请注意这里，重载了一个->运算符
  // 如果漏了这里，后续会发现接不上了
  const M* operator->() const noexcept { return ptr_; }

 private:
  const M* ptr_;
  template <class P> static constexpr M storage{std::in_place_type<P>};
};
```

这里其实没有太多玄机，就是用数据类型，例如`std::map<...>*`作为初始化参数去初始化一个`_Traits::meta`类型的指针。

`details::meta_ptr`使用类型`P`作为初始化的参数，因此**`_Traits::meta`**所有父类都使用了一个P类型作为初始化参数。**事实上，此时类型擦除已经完成了**。

# 类型擦除和函数调用

## 类型擦除

我们回顾一下`_Traits::meta`继承的一个重要的类`dispatcher_meta`：

```C++
using MP = overload_traits_impl<qualifier_type::lv, false, std::string, int>::meta_provider<false, MemAt>
template <class MP>
struct dispatcher_meta {
  constexpr dispatcher_meta() noexcept : dispatcher(nullptr) {}
  // 此时的P已经确定了
  template <class P>
  // 请注意这里dispatcher的初始化
  constexpr explicit dispatcher_meta(std::in_place_type_t<P>) noexcept
      : dispatcher(MP::template get<P>()) {}

  decltype(MP::template get<void>()) dispatcher;
};
```

对于`PrintDictionary(&container1);`，此时`P = std::map<int, std::string>*`已经定下来了。因此我们可以很轻松得知：

```C++
using MP = overload_traits_impl<qualifier_type::lv, false, std::string, int>::meta_provider<false, MemAt>
dispatcher_meta<MP>::dispatcher = MP::get<std::map<int, std::string>*>
```

从之前的分析已经知道，`overload_traits_impl::meta_provider::get`返回的是一个函数指针，和一开始手写版的`mAccessor`已经是一致的了。接下来我们看看这个`dispatcher`是怎么用起来的。

## `proxy_invoke`

目前我们是已经知道为什么`pro::proxy<Dictionary>`会拥有`std::string at(int)`方法了（通过`ia_`）。接下来看看这个方法是如何和传入的结构绑定起来的。

首先从`MemAt::accessor<Dictionary, CONV_IMPL, std::string(int)>::at`的实现入手：

```C++
std::string at(int idx) { 
    return ::pro::proxy_invoke<CONV_IMPL>(::pro::access_proxy<Dictionary>(*this), idx); 
}

// access_proxy还有很多版本，都是类似的
template <class F, class A>
proxy<F>& access_proxy(A& a) noexcept {
  return details::proxy_helper<F>::template access<
      A, details::qualifier_type::lv>(a);
}
```

参数部分，`::pro::access_proxy<Dictionary>(*this)`的目的是将this（即`ia_`）转换成`proxy<Dictionary>`，贴一下化简过的代码（通过`proxy_helper::access`实现）：

```C++
static proxy<Dictionary>& access(MemAt::accessor<...> &a) {
    auto* ptr1 = static_cast<facade_traits<F>::indirect_accessor*>(std::addressof(a));
    auto* ptr2 = reinterpret_cast<std::byte>(ptr1);
    auto* ptr3 = ptr2 - offsetof(proxy<F>, ia_);
    return reinterpret_cast<proxy<Dictionary>&>(*ptr3);
}
```

很好理解，就是需要通过`proxy<Dictionary>::ia_`获得`proxy<Dictionary>`的引用。因为知道成员变量的偏移量，通过指针的简单位移就能计算出来类的地址了，解指针就能获得引用了。

参数`idx`可以看出是完全拷贝了参数过来，截止到现在，我们知道`ia_`的`at`调用怎么又和proxy对象关联起来了，可以再补全一下图：

:::diagram 06-access-proxy
fig. 6 access_proxy 由 ia_ 的偏移量反推出 proxy 引用
:::

之后会出现挺多`details::qualifier_type::`_`lv`_之类的标识符，这里大概说明一下，这是为了配合`add_qualifier_t`一起使用，增加限定符用的：

```C++
using Type1 = add_qualifier_t<int, qualifier_type::lv>;     // int&
using Type2 = add_qualifier_t<int, qualifier_type::const_lv>; // const int&
using Type3 = add_qualifier_t<int, qualifier_type::rv>;     // int&&
using Type4 = add_qualifier_t<int, qualifier_type::const_rv>; // const int&&
```

先看看其中一种实现（其余的实现主要是限定符的不同，思路几乎一样），这里我稍微展开了一下代码，并且带入了几个类型的特化，核心就在于`proxy_helper::invoke`：

```C++
// C = CONV_IMPL
// F = Dictionary
// Args = int
template <class C, class F, class... Args>
decltype(auto) proxy_invoke(proxy<F>& p, Args&&... args) {
  return details::proxy_helper<F>::template invoke<
      C, details::qualifier_type::lv>(p, std::forward<Args>(args)...);
}

// C = CONV_IMPL
// F = Dictionary
// Args = int
// Q = details::qualifier_type::lv
template <class F>
struct proxy_helper {
  static inline const auto& get_meta(const proxy<F>& p) noexcept
      { return *p.meta_.operator->(); }
  template <class C, qualifier_type Q, class... Args>
  // 这个函数是proxy_invoke调用的
  // static decltype(auto) invoke(add_qualifier_t<proxy<F>, Q> p, Args&&... args) {
  // 上边的函数模板进行实例化就是
  static decltype(auto) invoke(proxy<Dictionary>& p, int idx) {
    using OverloadTraits = typename conv_traits<CONV_IMPL>
        ::template matched_overload_traits<Q, Args...>;
    auto dispatcher = p.meta_->template dispatcher_meta<typename OverloadTraits
        ::template meta_provider<C::is_direct, typename C::dispatch_type>>
        ::dispatcher;
    
      // 这里dispatcher是一个函数指针
      // 注意这里传入的已经是*p.ptr_了
      return dispatcher(std::byte&(*p.ptr_), int idx);
    }
  }
}
```

我们需要搞明白`dispatcher`里都做了什么，可以发现最终是走到了以下两个关键节点：

```C++
using OverloadTraits = typename conv_traits<CONV_IMPL>
        ::matched_overload_traits<details::qualifier_type::lv, int>;
// matched_overload_traits::meta_provider 就是 
// MP = overload_traits_impl<details::qualifier_type::lv, false, std::string, int>::meta_provider<false, MemAt>
auto dispatcher = p.meta_->template dispatcher_meta<typename OverloadTraits
        ::template meta_provider<CONV_IMPL::is_direct, typename CONV_IMPL::dispatch_type>>
        ::dispatcher;
```

`conv_traits<CONV_IMPL>`的相关信息在`_Traits::meta`的分析里我们已经分析过了，因此最终可以得到下边的展开，请注意`dispatcher_meta<MP>::dispatcher`的定义

```C++
using MP = overload_traits_impl<Q, false, std::string, int>::meta_provider<false, MemAt>
auto dispatcher = p.meta_->dispatcher_meta<MP>::dispatcher;

template <class MP>
struct dispatcher_meta {
  constexpr dispatcher_meta() noexcept : dispatcher(nullptr) {}
  template <class P>
  constexpr explicit dispatcher_meta(std::in_place_type_t<P>) noexcept
      : dispatcher(MP::template get<P>()) {}

// 这里get是个编译期求值的函数，指向overload_traits_impl::meta_provider::get<P>()
// P = proxy<Dictionary>
  decltype(MP::template get<void>()) dispatcher;
};
        
OverloadTraits = 
//
// Q = details::qualifier_type::lv （就是最普通的引用）
// NE = true 代表noexcept
// R = std::string
// Args = int
template <qualifier_type Q, false, std::string, class... Args>
struct overload_traits_impl : applicable_traits {
// IS_DIRECT = false
// D = MemAt
  template <bool IS_DIRECT, class D>
  struct meta_provider {
    template <class P>
    // 这里的get返回的也是一个函数指针
    // 这里就是 MP::get<std::map<int, std::string>*>
    static constexpr auto get()
        -> func_ptr_t<NE, R, add_qualifier_t<std::byte, Q>, Args...> {
      // 根据不同的编译参数，例如复制约束，是否直接调用等条件，会走不同的分支
      // 这里是我们的case会走的分支
        return &indirect_conv_dispatcher<D, P, Q, R, Args...>;
      // ...
    }
  };
  // ...
}
```

结合之前分析类型擦除时我们知道，当`P`定下来的时候，`dispatcher_meta<MP>::dispatcher` `= MP::get<std::map<int, std::string>*>`。

最终就可以知道`dispatcher`的类型是`indirect_conv_dispatcher<MemAt, proxy<Dictionary>, details::qualifier_type::lv, std::string, int>`。

带入模板参数后展开看一下`indirect_conv_dispatcher`，这里把ptr转成了`std::map&`的引用:

```C++
std::string indirect_conv_dispatcher(std::byte& self, int arg) {
  return invoke_dispatch(*std::map<int, std::string>*>&(&self)), arg);
}
```

发现主要调用到了`invoke_dispatch`，绕了一圈又回到了`MemAt`：

```C++
// D = MemAt
// Args 包括 std::map<int, std::string>& 和int
template <class D, class R, class... Args>
R invoke_dispatch(Args&&... args) {
  if constexpr (std::is_void_v<R>) {
    D{}(std::forward<Args>(args)...);
  } else {
    return D{}(std::forward<Args>(args)...); 
    // 实际上就是调用MemAt{}(std::map<int, std::string>& p, int idx);
  }
}

struct MemAt {
    // 最后回到了这里，这里重载了（）操作符
    template<class __T, class... __Args>
    decltype(auto) operator()(__T &&__self, __Args &&...__args) noexcept(noexcept(::std::forward<__T>(__self).at(::std::forward<__Args>(__args)...)))
    { 
        // 调用at方法
        return ::std::forward<__T>(__self).at(::std::forward<__Args>(__args)...); 
    }
    // 
}
```

最终可以补全成这样：

:::diagram 07-full-chain
fig. 7 at(int) 的完整调用链
:::

# 总结

本文中我们分析了proxy库中convention的实现，了解了如何在编译期进行类型擦除，以及在编译期注入特定方法的方式。总结来看，我们遇到了三个类型：

- `MemAt`，负责生成一些`accessor`的指令，以及最终函数调用的入口。
- `Directory`，负责组织多个convention，通过多重继承的方式使得自己拥有多个convention的方法。
- `proxy<Directory>`，根据`Directory`的编译信息生成meta信息，负责函数的类型擦除工作，以及原始数据的保存。

通过`proxy_invoke`将`at`方法和`dispatcher`返回的类型擦除的函数指针结合起来。

# 附加题：如何实现`FreeDispatch`

我们刚才讨论的是对于类方法的约束，考虑另一个问题，针对某些特定函数，我们是否可以创建一个代理，使得这个代理可以统一表示能够被特定函数接收的参数？自然是可以，如下所示：

```C++
PRO_DEF_FREE_DISPATCH(CALL, std::invoke, call);
struct Callable : pro::facade_builder ::add_convention<CALL, void(int)>::build {};

void foo(int b){
    std::cout << "foo! " << b << std::endl;
}

int main() {
    pro::proxy<Callable> p1 = &f;
    call(*p1, 1);
    pro::proxy<Callable> p2 = &foo;
    call(*p2, 42);
}
```

这里我们需要代理一组能够符合`std::invoke`调用的对象（很显然，就是lambda或者函数指针之类的）。此时使用`PRO_DEF_FREE_DISPATCH`来满足我们的需求。

这里本质上和成员函数的代理没什么区别，展开看一下`PRO_DEF_FREE_DISPATCH`：

```C++
struct CALL {
    template<class __T, class...__Args>
    decltype(auto)
    operator()(__T &&__self, __Args &&...__args)
    { return std::invoke(::std::forward<__T>(__self), ::std::forward<__Args>(__args)...); }
    
    template<class __F, class __C, class __R, class...__Args>
    struct accessor<__F, __C, __R(__Args...)> {
        friend __R call(accessor &__self, __Args...__args) {
            return ::pro::proxy_invoke<__C>(::pro::access_proxy<__F>(__self), ::std::forward<__Args>(__args)...);
        }
    };
}
```

`accessor`的实现略有不同，原来是在`accessor`中实现了一个成员函数`at`，现在是实现了一个友元函数`call`。因此继承`MemAt::accessor`可以有成员函数`at`，继承了`Call::accessor`则有友元函数`call`。

`at`和`call`的实现几乎都是一样的，通过`proxy_invoke`间接连接到`MemAt::operator()`或者`Call::operator()`。