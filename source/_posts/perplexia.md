---
title: 在服务器上搭建perplexia
date: 2025-02-22 02:03:00
toc: true
tags:
  - docker
  - ai
  - llm
index_img: /image/perplexia.webp
banner_img: /image/perplexia.webp
---
[Perplexia](https://github.com/ItzCrazyKns/Perplexica)是一个人工智能搜索引擎，是[Perplexity](https://www.perplexity.ai/)的开源替代版本。最近正好在公司内网的服务器上搭建一个Perplexia服务，记录一下中间遇到的问题，主要是来自于网络环境。
<!--more-->
# docker镜像的拉取
总所周知的原因，docker在国内拉取镜像并不友好，然而perplexia最合适的办法是通过docker compose启动服务。再试过几个镜像站都不好使之后，我尝试给服务器配置一个clash。具体方法可以使用[部署脚本](https://github.com/nelvko/clash-for-linux-install)，或者你自己配置。
之后就是指定docker拉取镜像的时候使用本地代理，修改配置文件之后重启即可：
```
# /lib/systemd/system/docker.service 不同机器可能环境不一样
Environment="HTTPS_PROXY=127.0.0.1:7890"
Environment="HTTP_PROXY=127.0.0.1:7890"
Environment=NO_PROXY=localhost,127.0.0.1
```
# Perplexia前端镜像编译
Perplexia默认提供的前端镜像是使用`127.0.0.1`作为后端服务地址的，因此如果使用默认的部署，前端就无法使用了。此时需要通过修改配置来更新默认地址（这奇葩的脑洞，改一次配置要编译一次新的），操作方式见[官方教程](https://github.com/ItzCrazyKns/Perplexica/blob/master/docs/installation/NETWORKING.md)
这时候你会发现docker image编译的时候依旧会报npm包拉不下来的情况，这是因为编译是单独启动一个镜像，这个镜像并不会使用我们本地的代理。所以需要在官方的docker-compose.yaml的`perplexia-frontend`修改一下build的配置：
```YAML
perplexica-frontend:
    build:
      context: .
      dockerfile: app.dockerfile
      args:
        - NEXT_PUBLIC_API_URL=http://127.0.0.1:3001/api
        - NEXT_PUBLIC_WS_URL=ws://127.0.0.1:3001 
        # 增加以下的配置，使得docker image使用本地代理
        - HTTP_PROXY=http://127.0.0.1:7890
        - HTTPS_PROXY=http://127.0.0.1:7890
        - NO_PROXY=localhost,127.0.0.1
```
> 这个脑回路也是挺奇特的，每次改ip都需要重新编译一次。建议如果长期部署的，单独本地编译前端代码并且弄个nginx之类的反向代理。
# searxng配置代理
Perplexia使用searxng作为搜索引擎，此时需要可以访问google这些搜索引擎，因此也需要配置代理。因为python本身httplib不默认使用系统当前的代理，因此注入`HPPTS_PROXY`是没意义的。
需要修改`searxng/settings.yml`，添加以下内容：
``` yaml
outgoing:
  proxies:
     all://:
        - http://127.0.0.1:7890
```
