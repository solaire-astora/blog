---
title: android native如何统计编译耗时
date: 2025-06-23 21:11:09
toc: true
tags:
  - cpp
  - android
index_img: /image/android_trace.webp
banner_img: /image/android_trace.webp
---
在进行C++开发时，我们有时需要统计项目的编译耗时情况，以便定位导致编译速度变慢的~~罪魁祸首~~。

对于使用Bazel的项目来说，这个问题很容易解决，只需在编译时添加：

```bash
bazel --profile
```

这样就能得到一个JSON文件，将其拖入[chrome://tracing/](chrome://tracing/)即可查看。你会看到一个类似Systrace的火焰图。当然如果你想更友好的ui和操作，可以使用[perfetto](https://ui.perfetto.dev/)来打开trace文件。

如果你和我一样使用的是Gradle+CMake，则需要进行一些额外设置：
# 使用ninja的trace功能

Ninja 构建系统在每次构建过程中都会生成一个名为 `.ninja_log` 的日志文件。该文件默认位于构建根目录中，记录了每个构建文件的相关信息，包括开始时间、结束时间、修改时间（mtime）、输出文件路径名和命令行哈希值。

你可以使用工具将 `.ninja_log` 转换为 trace 文件格式。这里推荐一个好用的工具：
这是一个简单的 Python 脚本，使用方法如下（你可以用find命令找一下：.ninja_log在哪）

```bash
python3 ninjatracing /path/to/build/.ninja_log > trace.json
```

生成 trace.json 文件后，将其拖入 [chrome://tracing/](chrome://tracing/) 查看分析结果。你会看到一个类似这样的 trace 图（这个图是我模糊过的），其中每个 trace 块代表一个编译单元，包括编译、链接及其他操作：

![编译耗时 trace 总览：多进程并行编译的时间分布](https://cdn.redhand.com.cn/img/20250701203606307.png)
从图中可以清楚地看到有一个编译 target 耗时较长，拖慢了整体编译时间。通过分析这个 target 的具体行为，我们可以有针对性地降低构建开销。
# 使用 clang 的 -ftime-trace 附加编译信息

如果你使用的是 clang 编译器，可以在 CMakeLists.txt 中添加以下配置：
```cmake
add_compile_options(-ftime-trace)
```
或者在 gradle 中为 `cppFlags` 添加 `-ftime-trace`
这样做会在每个 .o 文件旁生成一个对应的 json 文件，记录了该文件的编译开销。你可以使用 ninjatracing 解析这些 json 文件：
```shell
python3 ninjatracing /path/to/.ninja_log --embed-time-trace > trace.json
```
打开生成的 trace 文件后，你会看到如下效果：
![编译耗时火焰图：Frontend 与 Backend 各阶段的耗时占比](https://cdn.redhand.com.cn/img/20250701204319279.png)
这个视图直观地展示了编译过程中各个阶段的耗时情况。以这个 target 为例：
![单个编译单元的耗时明细](https://cdn.redhand.com.cn/img/20250701204340885.png)
可以发现 Frontend 阶段占用了约 40%-50% 的总时间，这表明源代码的解析和语义分析是主要瓶颈。造成这种情况的原因可能是代码中存在大量模板、复杂的符号依赖，或者源文件过大。而 PerformPendingInstantiations 阶段（紫色条）占用了约 30%-40% 的时间，与 Frontend 阶段耗时相近。这说明模板实例化也是编译过程中的一个主要瓶颈。
# MSVC下分析构建开销

msvc下的构建开销分析还是比较简单的，得益于[c++ building insights](https://learn.microsoft.com/zh-cn/cpp/build-insights/reference/sdk/overview?view=msvc-170)，你可以直接使用现成的工具或者插件，例如：[cpp build analyzer](https://github.com/MetanoKid/cpp-build-analyzer)
