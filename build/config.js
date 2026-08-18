/**
 * 站点配置 —— 索拉尔的主页
 */

export default {
  // 身份
  title: '索拉尔的主页',
  titleEn: 'SOLAIRE',
  praise: '赞美太阳',
  praiseEn: 'PRAISE THE SUN',
  author: 'zja',
  intro: 'C++ 内存模型、编码格式与语言机制的剖析。',
  quote: '如果你在游戏时也能坚持扮演一个好人，那么你真的就是一个好人。',
  description:
    'C++ 内存模型、编码格式与语言机制的剖析。索拉尔的主页，赞美太阳。',
  keywords: 'cpp, c++, go, k8s, protobuf, 系统底层',

  url: 'http://redhand.com.cn',
  language: 'zh-CN',

  // 导航：[路径, 英文, 中文]
  menu: [
    ['/', 'index', '首页'],
    ['/archives/', 'archive', '归档'],
    ['/tags/', 'tags', '标签'],
    ['/about/', 'about', '关于'],
    ['/atom.xml', 'rss', '订阅'],
  ],

  // 页脚
  since: 2022,
  icp: '', // 备案号，留空则不显示

  // 目录：收录到该层级为止的标题
  tocMaxLevel: 3,
};
