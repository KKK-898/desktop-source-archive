# 登录页企业 Logo 素材来源

采集日期：2026-11-10。服务对象及企业主体关系采用用户本次提供的名单；下列网站用于取得官方品牌素材，不用于额外推断整个集团与本产品的合作关系。登录页应同时显示实际服务主体名称。

所有图片均已保存至 `src/assets/customer-logos/`，页面展示不依赖远程图片。使用原始标志，仅进行透明边缘裁切、等比例缩放及 PNG 编码；没有使用生成式图像重绘商标。最大边长 384px，不放大低分辨率原图。

| 本地文件 | 用户提供的服务主体 | 标志所属品牌 | 官网及发现路径 | 原始图片 |
| --- | --- | --- | --- | --- |
| `jd-donghong.png` | 北京京东东鸿管理咨询有限公司 | 京东产发 JDP | [京东产发官网](https://jdp.com.cn/main.htm)，页面加载的 [导航](https://jdp.com.cn/PCnavigationbar.html) | [Logo](https://jdp.com.cn/static/image/logo.png) |
| `kuaishou-dajia.png` | 北京达佳互联信息技术有限公司 | 快手 | [关于快手](https://www.kuaishou.com/about/)，[页面公共样式](https://s2-11673.kwimgs.com/kos/nlav11673/static/css/chunk-common-eac0ad7c.chunk.css) 中的 header-logo-new | [Logo](https://s2-11673.kwimgs.com/kos/nlav11673/static/img/widgets/header/img/logo-104a0717.png) |
| `beike.png` | 贝壳找房（北京）科技有限公司 | 贝壳 | [贝壳官网](https://about.ke.com/home/)，[页面样式](https://s1.ljcdn.com/parma/client/css/2.e545f58f.chunk.css) 中的 header.white .icon | [Logo](https://s1.ljcdn.com/parma/client/media/src/client/pages/about/assets/logo_blue.097bc2ad.png) |
| `mahua.png` | 北京开心麻花演艺经纪有限公司 | 开心麻花 | [开心麻花网站](http://www.kaixinmahua.com.cn/) 的 logo_div 图片 | [Logo](http://www.kaixinguopiaowu.net/images/home_logo.png) |
| `miniworld.png` | 迷你创想科技（深圳）有限公司 | 迷你世界 | [迷你世界官网](https://www.mini1.cn/) 的页头 logo | [Logo](https://mnweb.mini1.cn/activity/miniweb/superHome/images/logo599526e30af12f76f4ce68eb0ca76878.png) |
| `modern-express.png` | 江苏现代快报传媒有限公司 | 现代快报+ | [现代快报官网](https://www.xdkb.net/) 的页头 logo | [Logo](https://www.xdkb.net/r/cms/www/default/images/index/logo.gif) |
| `supermap.png` | 北京超图软件股份有限公司 | SuperMap 超图 | [超图软件官网](https://cn.supermap.com/) 的页头 logo | [Logo](https://cn.supermap.com/zh-cn/template/pc/cn2016/images/logo.png) |
| `i-at.png` | 阿尔特汽车技术股份有限公司 | IAT 阿尔特 | [阿尔特官网](http://www.iat-auto.com/) 的 logo .img2 | [Logo](http://www.iat-auto.com/img/a1.png) |

## 个别素材处理

- 快手官方页头图为橙色图标、白色文字。保留原色，并合成 `#242424` 深灰底及少量留白，使其在登录页浅色 Logo 卡片中清晰可读。
- 现代快报原图将“现代快报+”红色标志与右侧文字口号组合。仅裁取左侧完整红色标志，保留 `+`，并移除白色背景、保留抗锯齿边缘，使其适配浅色卡片；不重绘字形。
- 阿尔特使用官网原始灰色 IAT 版本。官网另一版本为反白，不适合本次浅色卡片。
- 开心麻花及阿尔特官网本次 HTTPS 连接不可用，源页面与素材通过其 HTTP 页面取得；运行时无需再访问这些地址。
- 迷你世界原图为 120×50px，保持原始尺寸以避免插值放大；适合当前约 108×39px 展示区。
