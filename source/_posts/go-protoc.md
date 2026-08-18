---
title: protoc插件编写
date: 2023-05-22 16:57:29
tags:
  - go
  - protobuf
toc: true
---

利用`protoc`，可以解析`protobuf`文件生成。一般来说都是通过自定义插件，调用库方法来实现。官方的`protobuf`解析实际上也是利用插件完成的，例如`protoc-gen-go`。

早先使用`c++`版本书写的时候需要从`stdin`里获取`pb`文件的数据，之后再根据`descriptor`生成代码片段（或者是别的文本片段，`txt`,`json`或者别的你需要的文本，根据需求而定），最后把文本输出到`stdout`里。我们可以理解为实际上`protoc`就是把`proto`文件通过标准输入喂给了插件，之后截取标准输出作为生成的文件。这里实际上步骤是很繁琐的，所以之前很多同学宁可用点第三方的`parser`。

不过官方后续给`go`提供了一个比较好使的库，`google.golang.org/protobuf/compiler/protogen`，因此后续写插件我都推荐用`go`加上这个库来写。虽然用的是`go`，但是写出来的插件可以生成各种代码，只要是文本格式就可以（事实上不是文本也毫无问题）。

<!--more-->

# 最简单的插件

先从一个最简单的插件开始：根据`protobuf`文件输出它的`package name`，`message`列表，以及`rpc`列表到一个文本文件：

```protobuf
syntax = "proto3";
package test;

// Foo ...
message Foo {
  int32 a = 1;
  string b = 2;
}

message Bar {
  int64 a = 1;
}

service TestService {
  rpc Test (Foo) returns (Bar) {}
}
```

新建一个`go`项目，因为`protoc`的插件名字约定为`protoc-gen-xxx`，所以最好就叫做`protoc-gen-txt`。

插件的整体代码非常简单：

```go
package main

import (
  "fmt"
  "google.golang.org/protobuf/compiler/protogen"
)

func main() {
  protogen.Options{}.Run(
    func(p *protogen.Plugin) error {
      for _, f := range p.Files {
        if f.Generate {
          filename := f.GeneratedFilenamePrefix + ".txt"
          g := p.NewGeneratedFile(filename, f.GoImportPath)
          g.Write([]byte(fmt.Sprintf("package name: %s\n", *f.Proto.Package)))
          g.Write([]byte("Messages: \n"))
          for _, msg := range f.Messages {
            g.Write([]byte("  -"))
            g.Write([]byte(msg.Desc.Name()))
            g.Write([]byte("\n"))
          }
          for _, service := range f.Services {
            g.Write([]byte(fmt.Sprintf("service : %s\n", service.Desc.Name())))
            for _, rpc := range service.Methods {
              g.Write(([]byte(fmt.Sprintf("  - %s\n", rpc.Desc.Name()))))
            }
          }
        }
      }
      return nil
    })
}
```

先编译之后在项目目录下运行` protoc --plugin ./protoc-gen-txt --txt_opt=Mtest.proto=./ --txt_out=./ ./test.proto`，可以看到一个新生成了一个`test.txt`文件：

```
package name: test
Messages: 
	-Foo
	-Bar
service : TestService
  - Test
```

## 插件运行指令分析

首先我们分析一下执行的指令，`protoc`肯定没话说，整个转换的主函数，装了`protoc`就有的工具。

`--plugin ./protoc-gen-txt`是告知`protoc`，这次要加载一个叫做`protoc-gen-txt`的插件，它的路径就在当前目录下。当然如果这个插件本身就在系统路径里，也可以不加。

`--txt_opt=Mtest.proto=./`前半段代表一个选项参数，`txt_opt`代表给`protoc-gen-txt`这个插件传递的参数（参数我们后续再聊）。当然如果你是要给`protoc-gen-go`这个插件传递参数，那么就可以设置成`--go_opt=xxx`。后半段代表`test.proto`的`go import path`是`.`，通过`M`+文件名来声明。这是为了让插件能顺利执行，本身并没有特别意义。

`--txt_out=./`用于指定输出目录，即`txt`文件的输出目录。

## 插件代码分析

接下来简要分析一下插件代码：

这里首先生成了一个`protogen.Options`，样例中我们传的是空，实际上可以传递命令行参数进来，后续我们再考虑。这个`options`的`Run`方法接受一个`func(*protogen.Plugin) error`形式的函数或者方法作为参数。

其中`protogen.Plugin`是一个`protoc`插件的调用操作，可以看到其中包含了这次解析的文件的各种信息，我们需要的内容都在这个结构体里包含了。

之后的`NewGeneratedFile`生成了一个输出文件句柄，并且获得了它的引用。之后我们就可以调用`Write`方法把文件内容输出了。至于文件的`flush`和`close`方法没有提供，也无需我们手动调用。如果对于一个`proto`文件我们需要输出两个文件，可以多调用`NewGeneratedFile`一次获得一个新的文件句柄，参考如下修改：

```go
filename := f.GeneratedFilenamePrefix + ".txt"
g := p.NewGeneratedFile(filename, f.GoImportPath)
g2 := p.NewGeneratedFile(f.GeneratedFilenamePrefix+"2.txt", f.GoImportPath) // 新增一个文件
g.Write([]byte(fmt.Sprintf("package name: %s\n", *f.Proto.Package)))
g.Write([]byte("Messages: \n"))
for _, msg := range f.Messages {
  g.Write([]byte("  -"))
  g.Write([]byte(msg.Desc.Name()))
  g.Write([]byte("\n"))
}
// 以下关于service的信息都输出到了另一个test2.txt中
for _, service := range f.Services {
  g2.Write([]byte(fmt.Sprintf("service : %s\n", service.Desc.Name())))
  for _, rpc := range service.Methods {
    g2.Write(([]byte(fmt.Sprintf("  - %s\n", rpc.Desc.Name()))))
  }
}
```

我们会得到两个文件，更多的文件需求以此类推，不再赘述。

## protobuf 文件结构

如样例中所示，我们需要的所有有关于`protobuf`文件的信息都存储在`protogen.File`中。正常情况下我们常用的结构体有这些：

- `protogen.Message` 用于描述`Message`的定义
- `protogen.Service`和`protogen.Method`用于描述定义的`service`和它包含的`rpc`的信息
- `protoreflect.Descriptor`定义了一堆的描述，用于描述一个消息/方法/服务的名字。例如`protoreflect.MessageDescriptor`用于描述`message`，`protoreflect.FieldDescriptor`用于描述`message`的每个`field`。

因为库代码是开源的，因此上述的结构体描述都可以在源文件中看到，按需取用即可。

 # 使用模板生成文本

在上一节中我们尝试用`tab`来让生成的文件带有点格式化，显然这么做十分低效，而且非常不直观，稍不留意就可能搞坏格式（此时假设你需要生成的是一份`python`代码……）。这里介绍一个比较好用的包：`text/template`，方便我们使用模板来生成一些通用的文本文件，例如 HTML 文件和配置文件。

首先先建立一个模版，`out.tmpl`：

```
{{if .Generate}}
package name: {{.Proto.Package}}
Messages:
{{- range .Messages }}
  - {{.Desc.Name}}
{{- end }}

{{- range .Services }}
service : {{ .Desc.Name }}
{{- range .Methods }}
  - {{ .Desc.Name }}
{{- end }}
{{- end }}
{{end}}
```

之后将我们的代码修改成这样：

```go
package main

import (
  "embed"
  "text/template"

  "google.golang.org/protobuf/compiler/protogen"
)

//go:embed out.tmpl
var outTemplate embed.FS

func main() {
  protogen.Options{}.Run(
    func(p *protogen.Plugin) error {
      for _, f := range p.Files {
        filename := f.GeneratedFilenamePrefix + ".txt"
        g := p.NewGeneratedFile(filename, f.GoImportPath)

        t := template.New("out")

        tfile := template.Must(t.ParseFS(outTemplate, "*"))
        if err := tfile.Lookup("out.tmpl").Execute(g, f); err != nil {
          panic(err)
        }
      }
      return nil
    })
}
```

这里引入了几个库，首先是`embed`包

> 它可以将文件或一个或多个文件的内容嵌入到 Go 二进制文件中，允许在程序运行时访问这些文件的内容，而无需读取外部文件。因此，这个包使得分发静态资源变得更加方便。

因此我们利用它将`out.tmpl`打包到二进制文件中，否则我们的插件还会依赖模版文件，就相当不妙。

```go
// 注意这边这个注释是go的编译指令，不可以省略
//go:embed out.tmpl
var outTemplate embed.FS
```

其次是`template`包：

```go
tfile := template.Must(t.ParseFS(outTemplate, "*"))
// 这里的g是需要生成的文件 f是*protogen.File
if err := tfile.Lookup("out.tmpl").Execute(g, f); err != nil {
    panic(err)
}
```

相当于将`protobuf`的文件信息丢给这个模板，最终期望将数据写入文件中。

## template语法

首先是**变量**，在模版中，变量用`{{ }}`括起来：

```txt
package name: {{.Proto.Package}}
```

其中`.Proto.Package`是一个操作符，代表当前模板中的上下文的`.Proto.Package`。此时模板的上下文是`f (*protogen.File)`（在代码中传入的），因此这里可以认为是

```
package name: {{f.Proto.Package}}
```

和我们之前的代码很像：

```go
g.Write([]byte(fmt.Sprintf("package name: %s\n", *f.Proto.Package)))
```

其次是**循环**：

```
{{- range .Messages }}
  - {{.Desc.Name}}
{{- end }}
```

很显然这里的`.Message`就代表了`f.Message`。`{{- range .Messages }}`则代表了遍历`f.Message`。

但是需要注意的是，循环中的上下文已经不是`f`了，而是遍历`.Messages`时当前迭代的元素。这里的效果其实也等效于之前的代码：

```go
for _, msg := range f.Messages {
  g.Write([]byte("  -"))
  g.Write([]byte(msg.Desc.Name()))
  g.Write([]byte("\n"))
}
```

最后是**判断**：

模版的开头就使用以下语句根据`f.Gengerate`判断是否要生成对应的`txt`文件：

```
{{if .Generate}}
...
{{end}}
```

有点类似原来代码里的这段：

```go
if f.Generate {
 ....
}
```

但是有稍许不同，因为原来的代码不会走到文件生成这里，但是在模板里判断无论如何都会生成一个`txt`文件。

## 模板的进阶用法

在前一个小节里我们看到，模板可以直接引用到上下文的数据信息。但是有时候我们需要输出的信息可能会需要插件额外加工，例如我们可能需要获取全小写的消息名，那么就不能直接引用原始的数据，而是希望能够调用我们自定义的方法。为此我们需要对模版做一些修改：

```
package name: {{.Proto.Package}}
Messages:
{{- range .Messages }}
  - {{.Desc.Name}}, lower case: {{LowerName .Desc.Name}}
{{- end }}
```

请注意，这里的`LowerName`并不以`.`开头了，这在模板的语法中代表需要调用一个外部的函数。而调用的参数则是`.Desc.Name`。此时我们对插件的代码也做出一些修改：

```go
import (
  "embed"
  "strings"
  "text/template"

  "google.golang.org/protobuf/compiler/protogen"
  "google.golang.org/protobuf/reflect/protoreflect"
)

//go:embed out.tmpl
var outTemplate embed.FS

func main() {
  protogen.Options{}.Run(
    func(p *protogen.Plugin) error {
      for _, f := range p.Files {
        filename := f.GeneratedFilenamePrefix + ".txt"
        g := p.NewGeneratedFile(filename, f.GoImportPath)

        t := template.New("out")
        // 请注意这里 新增了一个映射
        t.Funcs(map[string]interface{}{
          "LowerName": func(name protoreflect.Name) string {
            return strings.ToLower(string(name))
          },
        })
        tfile := template.Must(t.ParseFS(outTemplate, "*"))
        if err := tfile.Lookup("out.tmpl").Execute(g, f); err != nil {
          panic(err)
        }
      }
      return nil
    })
}
```

和的不同就是新增了这一段：

```go
t.Funcs(map[string]interface{}{
  "LowerName": func(name protoreflect.Name) string {
    return strings.ToLower(string(name))
  },
})
```

很显然，这里是通过增加了一个标识符到匿名函数的映射。当模板解析到`LowerName`时，就知道调用对应的函数，并且将返回值用于替换变量。

# 插件的命令行参数

在第一章中我们跑第一个例子就见到了插件的命令行参数了：

```bash
protoc --plugin ./protoc-gen-txt --txt_opt=Mtest.proto=./ --txt_out=./ ./test.proto
```

这里的`--txt_opt=Mtest.proto=./`就是命令行参数，`txt_opt`代表给`protoc-gen-txt`的参数。我们可以对原有的插件代码做一些修改，让给插件传递一些参数：

```go
package main

import (
  "embed"
  "flag"
  "strings"
  "text/template"

  "google.golang.org/protobuf/compiler/protogen"
  "google.golang.org/protobuf/reflect/protoreflect"
)

//go:embed out.tmpl
var outTemplate embed.FS

func main() {
  var flags flag.FlagSet

  // 这里增加了一个flag
  needGenerate := flags.Bool("generate", false, "if we need generate")
  protogen.Options{
    ParamFunc: flags.Set,
  }.Run(
    func(p *protogen.Plugin) error {
      for _, f := range p.Files {
        if !*needGenerate {
          continue
        }
        filename := f.GeneratedFilenamePrefix + ".txt"
        g := p.NewGeneratedFile(filename, f.GoImportPath)

        t := template.New("out")
        t.Funcs(map[string]interface{}{
          "LowerName": func(name protoreflect.Name) string {
            return strings.ToLower(string(name))
          },
        })
        tfile := template.Must(t.ParseFS(outTemplate, "*"))
        if err := tfile.Lookup("out.tmpl").Execute(g, f); err != nil {
          panic(err)
        }
      }
      return nil
    })
}
```

使用以下命令行参数进行转表

```bash
protoc --plugin ./protoc-gen-txt --txt_out=./ --txt_opt=Mtest.proto=./,generate=true ./test.proto 
```

或者也可以使用如下方式将命令行参数加入进来：

```bash
protoc --plugin ./protoc-gen-txt --txt_out=Mtest.proto=./,generate=true:. ./test.proto
```

# 读取扩展信息

通常我们在业务上会需要定义一些扩展信息方便使用，先增添一个`option.proto`文件：

```protobuf
syntax = "proto2";
import "google/protobuf/descriptor.proto";

package option_test;
option go_package = "./optiontest";

extend google.protobuf.MessageOptions {
  optional bool needgenerate = 10001; // 是否需要生成
}
```

之后修改原有的`test.proto`

```protobuf
syntax = "proto3";
package test;

import "option.proto";

// Foo ...
message Foo {
  option (option_test.needgenerate) = true;
  int32 a = 1;
  string b = 2;
}

message Bar { int64 a = 1; }

service TestService {
  rpc Test(Foo) returns (Bar) {}
}
```

这样就引入了一个扩展，用于标记是否要生成这个`message`的信息，为了利用这个信息，我们可以对`main.go`和`out.tmpl`稍作修改：

```go
package main

import (
  "embed"
  "protoc-gen-txt/optiontest"
  "strings"
  "text/template"

  "google.golang.org/protobuf/compiler/protogen"
  "google.golang.org/protobuf/proto"
  "google.golang.org/protobuf/reflect/protoreflect"
)

//go:embed out.tmpl
var outTemplate embed.FS

func main() {
  protogen.Options{}.Run(
    func(p *protogen.Plugin) error {
      for _, f := range p.Files {
        if !f.Generate {
          continue
        }
        filename := f.GeneratedFilenamePrefix + ".txt"
        g := p.NewGeneratedFile(filename, f.GoImportPath)

        t := template.New("out")
        // 请注意这里 新增了一个映射
        t.Funcs(map[string]interface{}{
          "LowerName": func(name protoreflect.Name) string {
            return strings.ToLower(string(name))
          },
          "Generate": func(desc protoreflect.MessageDescriptor) bool {
            generate, ok := proto.GetExtension(desc.Options(), optiontest.E_Needgenerate).(bool) // 在这里读取扩展
            if !ok {
              return false
            }
            return generate
          },
        })
        tfile := template.Must(t.ParseFS(outTemplate, "*"))
        if err := tfile.Lookup("out.tmpl").Execute(g, f); err != nil {
          panic(err)
        }
      }
      return nil
    })
}

```

```txt
package name: {{.Proto.Package}}
Messages:
{{- range .Messages }}
  {{if Generate .Desc}}
  - {{.Desc.Name}}, lower case: {{LowerName .Desc.Name}}
  {{end}}
{{- end }}
```

为了编译这个工具，这次要多加一步：

```shell
protoc --go_out=./ ./option.proto
protoc --plugin ./protoc-gen-txt --txt_opt=Mtest.proto=./ --txt_out=./ ./test.proto
```

第一步用于将`option.proto`编译成`go`代码，在`main.go`中引用。

分析代码，在模板里多了这么一段，用于判断是否需要生成对应`msg`的信息：

```txt
{{if Generate .Desc}}
  - {{.Desc.Name}}, lower case: {{LowerName .Desc.Name}}
{{end}}
```

根据模板里的说明，我们知道这里会试图寻找一个名为`Generate`的函数，它的实现在`main.go`里：

```go
"Generate": func(desc protoreflect.MessageDescriptor) bool {
  generate, ok := proto.GetExtension(desc.Options(), optiontest.E_Needgenerate).(bool) // 在这里读取扩展
  if !ok {
  return false
  }
  return generate
},
```

这里的核心逻辑就在于`proto.GetExtension`，这是用于获取`Msg`的扩展用的。其中`optiontest.E_Needgenerate`就对应了`option.proto`里的`needgenerate`。生成的代码在`option.pb.go`里，代码不长，可以看看扩展在`go`中是怎么定义的。

获取了指定的扩展信息之后，就可以读出在`msg`中扩展的赋值，这里我们用一个`bool`值判断是否需要生成代码。之后如果在业务上大家也有类似的需要，也可以使用别的值，例如`int32`和`string`。



