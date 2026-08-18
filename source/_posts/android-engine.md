---
title: 游戏引擎在安卓下的实现
date: 2024-09-23 21:11:09
toc: true
tags:
  - cpp
  - android
---
一般游戏引擎都是使用c++实现逻辑，再通过一个虚拟机实现用脚本语言维护业务逻辑。因此在安卓下进行一层包装是十分必要的，使得引擎能够和安卓接口交互，也能正确地管理生命周期。
<!--more-->
# Unreal
## 启动
初始化流程如下图所示：

:::diagram android-launch-sequence
fig. 1 从 GameActivity 到 UE4 的启动时序
:::

在Android侧，使用`SplashActivity`作为入口。主要处理一些机型的适配，权限处理。创建`GameActivity`之后会调用`finish`自行销毁。
`GameActivity`是一个`NativeActivity`，`NativeActivity`通过`loadNativeCode`方法实现了一套自有looper事件处理逻辑。在调用了`loadNativeCode`之后，会在c++侧创建一个子线程，即UE的`GameThread`。目前是在`onCreate`中通过调用super的`onCreate`：
```Java
public void onCreate(Bundle savedInstanceState)
{
    _activity = this;
    InternalFilesDir = getFilesDir().getAbsolutePath() + "/";
    ExternalFilesDir = getExternalFilesDir(null).getAbsolutePath() + "/";
    
    Logger.RegisterCallback(this);

       // Grab a reference to the asset manager
    AssetManagerReference = this.getAssets();
    
    // 这个地方会调用loadNativeCode去初始化c++侧的代码，实际上会新建GameThread线程
    super.onCreate(savedInstanceState);
    ...
    // 之后是一些dialog加载，button创建，各种设置。onCreate之后就没有等待c++层的地方了
}
```
接下来的engine初始化流程来到GameThread内，实际的入口为`LaunchAndroid::android_main`。
> 此实际上engine的初始化流程过长也不会影响到主线程，这样可以避免出现ANR的情况。

`android_main`主要做了三件事：
- 记录主线程ID
- 创建AndroidEventThread，用于处理cmd和input事件
    > engine从cmd和input事件获取到来自主线程的回调
- 执行`AndroidMain`
```C++
void android_main(struct android_app* state)
{
    FTaskTagScope Scope(ETaskTag::EGameThread);
    // 记录game thread线程id
    GGameThreadId = FPlatformTLS::GetCurrentThreadId();

    // 记录native app
    GNativeAndroidApp = state;
    check(GNativeAndroidApp);
    
    // 创建event线程，用于处理来自main thread的下次
    pthread_attr_t otherAttr; 
    pthread_attr_init(&otherAttr);
    pthread_attr_setdetachstate(&otherAttr, PTHREAD_CREATE_DETACHED);
    pthread_create(&G_AndroidEventThread, &otherAttr, AndroidEventThreadWorker, state);
    
    // 进入主循环
    AndroidMain(state);
}
```
`AndroidMain`是实际上的engine的主循环，主要做了以下几件事情：
- 等待`GResumeMainInit`初始化，这个flag会在`GameActivity`调用完`onResume`之后设置。说明此时`GameActivity`已经准备完毕了，可以开始交互。
- 初始化文件系统权限
- **engine的初始化流程**
- 游戏tick循环
- 游戏退出
> 代码太长不贴了，在LaunchAndroid.cpp里
## 事件交互
如前所述，`android_main`新建了一个新的线程用于处理Android的事件。线程的处理函数在`LaunchAndroid::AndroidEventThreadWorker`中。这个函数主要做了几件事情：
- 创建一个`ALooper`，设置为app的looper（可以理解为用一个类似epoll的功能接管了native层收到的所有消息，详情可以参考[Android C++系列：JNI中的Handler--ALooper_c++_轻口味_InfoQ写作社区](https://xie.infoq.cn/article/bdc7e9343e1aa0bec03be571b)）
- 设置`onAppCmd`和`onInputEvent`的回调，它俩分别处理app的消息和用户输入消息。
- 开始事件循环`AndroidProcessEvents`
```C++
static void* AndroidEventThreadWorker( void* param )
{
    // ...

    // 绑定Alooper
    ALooper* looper = ALooper_prepare(ALOOPER_PREPARE_ALLOW_NON_CALLBACKS);
    ALooper_addFd(looper, state->msgread, LOOPER_ID_MAIN, ALOOPER_EVENT_INPUT, NULL, &state->cmdPollSource);
    state->looper = looper;
    
    // 设置回调
    state->onAppCmd = OnAppCommandCB;
    state->onInputEvent = HandleInputCB;
    // 处理事件循环
    while (!IsEngineExitRequested())
    {
       AndroidProcessEvents(state);
       sleep(EventRefreshRate);     // this is really 0 since it takes int seconds.
    }
    return NULL;
}
```
这里用新的线程中绑定`Alooper`的作用是避免事件的回调在Game Thread上触发。而是在engine的tick中集中处理掉这些事件。
`AndroidProcessEvents`基本上是一个类似epoll的处理函数，取出时间并且触发处理，没太多值得看的东西：
```C++
static void AndroidProcessEvents(struct android_app* state)
{
    int ident;
    int fdesc;
    int events;
    struct android_poll_source* source;

    while((ident = ALooper_pollAll(-1, &fdesc, &events, (void**)&source)) >= 0)
    {
       // process this event
       if (source)
       {
           // 这里的process自然会调用到绑定的回调OnAppCommandCB和HandleInputCB
          source->process(state, source);
       }
    }
}
```
在回调中，根据消息id会分派到对应逻辑去处理。基本上都是塞进一个消息队列中，等Game Thread主循环的tick中处理：

```C++
static void OnAppCommandCB(struct android_app* app, int32_t cmd)
{
    // ...

    switch (cmd)
    {
    case APP_CMD_SAVE_STATE:
       UE_LOG(LogAndroid, Log, TEXT("Case APP_CMD_SAVE_STATE"));
       // 这里直接把事件塞入消息队列中
       FAppEventManager::GetInstance()->EnqueueAppEvent(APP_EVENT_STATE_SAVE_STATE);
       break;
       // ...
    case APP_CMD_DESTROY: // 这是gameactivity退出的事件
    FAppEventManager::GetInstance()->EnqueueAppEvent(APP_EVENT_RUN_CALLBACK, FAppEventData([]()
    {
       // 这里post到game thread里去执行
       FGraphEventRef WillTerminateTask = FFunctionGraphTask::CreateAndDispatchWhenReady([]()
       {
          PRAGMA_DISABLE_DEPRECATION_WARNINGS
          FCoreDelegates::ApplicationWillTerminateDelegate.Broadcast();
          PRAGMA_ENABLE_DEPRECATION_WARNINGS

          FCoreDelegates::GetApplicationWillTerminateDelegate().Broadcast();
       }, TStatId(), NULL, ENamedThreads::GameThread);
       FTaskGraphInterface::Get().WaitUntilTaskCompletes(WillTerminateTask);
       // 真正退出的地方
       FAndroidMisc::NonReentrantRequestExit();
    }));

    // 额外再发一个destroy的事件
    FAppEventManager::GetInstance()->EnqueueAppEvent(APP_EVENT_STATE_ON_DESTROY);
    break;
   }
}
```
## 其它交互
如之前所述，目前所有的事件都会从`GameActivity`转发到c++层处理。这里就不再赘述。
# Cocos
## 启动
和Unreal选择使用NativeActivity不同，cocos选择了使用安卓原生（jetpack）提供的`GameActivity`作为应用的入口：(https://developer.android.com/games/agdk/game-activity)
> 按照官方的说法：我们强烈建议您将 **`GameActivity`** 用于新游戏和其他 C/C++ 密集型应用。如果您已有 **`NativeActivity`** 应用，我们建议您迁移到 **`GameActivity`**。

具体的启动流程如下图：

:::diagram cocos-launch-sequence
fig. 2 Cocos 的启动时序 —— 入口是 jetpack 原生的 GameActivity
:::

从上图中我们可以很轻易发现除了使用了原生的`GameActivity`之外，没有再额外创建一个新的事件交互线程去处理安卓事件。实际上这是官方推荐的[使用方式](https://developer.android.com/games/agdk/game-activity/get-started)
除此之外，两边的共同点都是
- 在native线程而非java线程中处理game loop
- 游戏初始化在native线程中
## 事件交互
相比之下，对于事件的处理在cocos中就简单很多，以下是cocos主循环的代码：
```C++
int32_t AndroidPlatform::loop() {
    IXRInterface *xr = CC_GET_XR_INTERFACE();
    while (true) {
        int events;
        struct android_poll_source *source;
        
        // 这里直接处理所有的安卓事件
        while ((ALooper_pollAll(_loopTimeOut, nullptr, &events,
                                reinterpret_cast<void **>(&source))) >= 0) {
            // process event
            if (source != nullptr) {
                source->process(_app, source);
            }

            // Exit the game loop when the Activity is destroyed
            if (_app->destroyRequested) {
                break;
            }
        }
        
        // Exit the game loop when the Activity is destroyed
        if (_app->destroyRequested) {
            break;
        }
        // 处理framebegin
        if (xr && !xr->platformLoopStart()) continue;
        // ...
        // 处理frameend
        if (xr) xr->platformLoopEnd();
    }
    onDestroy();
}
```
相比于Unreal，cocos通过利用安卓原生的能力，相比之下就简单直白很多。唯一的问题是占用了一部分主循环的时间处理。不过处理switch-case省下的时间未必就比跨线程操作队列来得更迅速。
# Unity
在unity6之前，gameloop是实现在java线程的，但是在unity6上，已经将`GameActivity`作为了可选的安卓入口（在设置中搜索Application Entry Point）。因此交互流程大同小异，不再赘述（最主要是看不到代码XD）。
# 分析
可以发现，支持安卓的引擎在实现安卓的入口时，几乎都倾向于使用`GameActivity`的方式，unreal的实现中也几乎是生造了一个类似的实现。对比一下，我们可以发现有这两点优势：
- 减少大量jni的接口，基本管理frameloop需要做的jni接口都已经由`native_app_glue`实现了
- 更好地控制app和安卓层的交互，消息交互部分变得更清晰了，在主线程处理即可
- 生命周期更好管理，native线程天然和`GameActivity`生命周期绑定，尤其是“唯一性”
