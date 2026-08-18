---
title: 使用Kind在windows上搭建个人用的k8s
date: 2023-08-10 20:23:36
tags:
  - go
  - k8s
toc: true
---

在学习k8s的过程中，出于实践的需要，我们经常需要对k8s集群做一些敏感操作，例如使用hostpath，安装daemonset。所以在自己的开发机上组建一个简单的k8s集群是很必要的。本文将会介绍如何使用wsl+Kind搭建一个k8s集群。
<!-- more -->
# Kind介绍和安装
[Kind(Kubernetes IN Docker)](https://kind.sigs.k8s.io/)是一个基于Docker的工具，用于在本地计算机上运行k8s集群。在Kind中，每个node都是以docker的形式存在的，实际上对应的形式应该是docker on docker，如下图所示：
![kind 官方架构图：Host 上的 Docker 容器内运行 systemd、kubelet 与各 k8s 组件](https://cdn.redhand.com.cn/img/diagram.png)
因此我们可以很容易地搭建多节点的k8s集群，只要跑多个docker即可。

## 配置wsl2和docker
首先，需要安装和配置好WSL2，具体可以参考[微软的WSL2安装教程](https://learn.microsoft.com/zh-cn/windows/wsl/install)。之后就可以选择你喜欢的Linux发行版，这里建议选择Ubuntu，通用性会强一点，避免不必要的麻烦。

之后需要安装docker destokp，建议直接选择使用wsl2做后端，这样docker启动的速度会比用hpyer-v要快速很多（原理就是用wsl的linux作为虚拟机，代替使用hpyer-v启动的虚拟机）。为了能在我们安装的wsl中也使用docker，可以再开启[用windows上的docker作为后端](https://docs.docker.com/desktop/wsl/)（一般安装新版的都会默认勾选），这样wsl中只安装一个docker client，连接到windows上跑着的docker。相比之下这样我们从windows上也可以登录这个docker，会方便很多。
## 安装Kind
Kind需要被安装在WSL中（其实安装在windows上也可以，不过我没有尝试过），在WSL上安装Kind比较简单，只需要下载二进制文件并且拷贝到PATH中：
```shell
[ $(uname -m) = x86_64 ] && curl -Lo ./kind https://kind.sigs.k8s.io/dl/v0.20.0/kind-linux-amd64
chmod +x ./kind
sudo mv ./kind /usr/local/bin/kind
```
此时运行`kind version`检查kind是否安装正常。

为了能够正常控制k8s集群，建议还需要安装kubectl：

```shell
# 下载
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
# 安装
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl
# 验证
kubectl version --client --output=yaml
```

## 新建cluster

使用Kind新建一个cluster非常简单，只需要：

```shell
kind create cluster --name kind-test
```

此时执行`kind get clusters`就可以获取到当前有效的集群。

但是这种方式新建的集群只有一个node，对于我们需要使用多个node的情况就需要使用配置文件来创建cluster，新建一个`kind-config.yaml`文件：

```yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
- role: control-plane
- role: worker
- role: worker
- role: worker
```

这里主要关注最后的`nodes`字段，标明了集群中一共有1个控制面节点，3个worker节点。使用指令创建它：

```shell
kind create cluster --name multinode-test --config kind-config.yaml
```

如果你用的docker后端是windows docker，那么可以在docker desktop看到新建的这几个代替pod的docker：
![kind 集群创建完成后的终端输出](https://cdn.redhand.com.cn/img/20230823154339.png)
通过使用kubectl可以切换交互的集群：

```shell
# 和刚才创建的集群交互
kubectl cluster-info --context multinode-test
```

## 暴露端口
如果需要将我们的服务暴露到本地可以访问，可以通过暴露端口的方式创建集群：
```yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
# patch the generated kubeadm config with some extra settings
kubeadmConfigPatches:
- |
  apiVersion: kubelet.config.k8s.io/v1beta1
  kind: KubeletConfiguration
  evictionHard:
    nodefs.available: "0%"
# patch it further using a JSON 6902 patch
kubeadmConfigPatchesJSON6902:
- group: kubeadm.k8s.io
  version: v1beta3
  kind: ClusterConfiguration
  patch: |
    - op: add
      path: /apiServer/certSANs/-
      value: my-hostname
# 1 control plane node and 3 workers
nodes:
# the control plane node config
# 请注意这里的端口暴露配置
- role: control-plane
  extraPortMappings:
  - containerPort: 80
    hostPort: 80
    protocol: TCP
  - containerPort: 443
    hostPort: 443
    protocol: TCP
  - containerPort: 30000
    hostPort: 30000
    protocol: TCP
# the three workers
- role: worker
- role: worker
- role: worker
```
此时相当于在control-plane这个node上暴露了80 443和30000三个端口，并且映射到了本机的三个相同端口。
# 问题排查

如果你的开发机资源比较少，可能会导致分配给docker的资源较少（CPU，内存），导致无法创建出多节点的集群。此时需要[调整docker的wsl虚拟机的资源限制](https://learn.microsoft.com/zh-cn/windows/wsl/wsl-config)。

此外，Kind使用的是Kindest/node镜像，因此需要确认网络是否正常，能够下载对应的镜像，避免下载失败。