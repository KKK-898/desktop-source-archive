# 登录页高校 Logo 素材补充来源

采集日期：2026-11-10。此文件记录西湖大学、中南财经政法大学、深圳大学、浙江师范大学、兰州大学、中国农业大学 6 家素材。服务对象名单由用户提供；素材来自各校官方站点，与客户关系核实相互独立。

| 本地文件 | 学校 | 官方发现页面 | 原始资源 | 处理方式 |
| --- | --- | --- | --- | --- |
| `westlake.png` | 西湖大学 | [学校官网](https://www.westlake.edu.cn/)，其 [headerHome.js](https://www.westlake.edu.cn/images/headerHome.js) 引用彩色页头标识 | [header_icon_color.png](https://www.westlake.edu.cn/images/header_icon_color.png) | 从官方横版组合标识中裁取左侧蓝金独立符号，保持颜色、形状与比例。 |
| `zuel.png` | 中南财经政法大学 | [大学之窗／学校标识](https://www.zuel.edu.cn/dxzc/list.htm) 正文中的标准校徽图片 | [标准校徽 JPG](https://www.zuel.edu.cn/_upload/article/images/92/6b/0ca1d7a440f7a55ac9018fd5c84b/595acfaf-3586-4708-b607-832414d3a13e.jpg) | 保留完整圆形校徽，移除白色底并保留抗锯齿边缘，转 PNG。 |
| `szu.png` | 深圳大学 | [学校官网](https://www.szu.edu.cn/) 页头标识 | [logo_03.png](https://www.szu.edu.cn/images/logo_03.png) | 裁取官方横版标识左侧完整洋红色圆形校徽，去掉右侧长校名。 |
| `zjnu.png` | 浙江师范大学 | [学校官网](https://www.zjnu.edu.cn/) 页头标识 | [logo2.png](https://www.zjnu.edu.cn/_upload/tpl/01/8e/398/template398/images/logo2.png) | 裁取官方横版标识左侧完整绿色校徽，去掉右侧反白长校名。 |
| `lzu.png` | 兰州大学 | [兰州大学信息公开平台](https://xxgk.lzu.edu.cn/) 页头标识 | [logo.png](https://xxgk.lzu.edu.cn/xxgknew/theme/default/logo.png) | 裁取左侧蓝色圆形校徽，去掉校名及“信息公开平台”文字。 |
| `cau.png` | 中国农业大学 | [学校视觉识别系统](https://www.cau.edu.cn/xxgk/whbz/sjsbxt/index.htm) | [标准绿色盾徽](https://www.cau.edu.cn/static2022/images/sub016_img1.png) | 裁去留白，移除白色背景，保留绿色盾徽及其抗锯齿边缘；没有使用首页周年庆标志。 |

文件均位于 `src/assets/customer-logos/`，最大边长不超过 384px。保持学校原始颜色，不重绘、不改造字形。各卡片另行显示学校名称，因此采用独立校徽能够在约 108×39px 的展示框中保留更高辨识度。

兰州大学主站、英文站和部分院系站本次返回 HTTP 412，因此使用可直接访问的学校官方信息公开平台资源。所有图片已本地化，运行时无需访问来源网站。
