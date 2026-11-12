export interface LoginCustomer {
  id: string
  name: string
  legalName: string
  logo: string
  kind: 'university' | 'company'
}

// Service copy and the customer list are supplied by the product owner.
// Keep legal entities explicit when a logo represents their wider brand.
export const loginServiceStats = [
  { value: '1,000+', label: '服务企业与机构' },
  { value: '10,000+', label: '累计服务用户' },
]

export const loginCustomers: LoginCustomer[] = [
  { id: 'tsinghua', name: '清华大学', legalName: '清华大学', logo: new URL('./assets/customer-logos/tsinghua.png', import.meta.url).href, kind: 'university' },
  { id: 'kuaishou-dajia', name: '达佳互联 · 快手', legalName: '北京达佳互联信息技术有限公司', logo: new URL('./assets/customer-logos/kuaishou-dajia.png', import.meta.url).href, kind: 'company' },
  { id: 'hust', name: '华中科技大学', legalName: '华中科技大学', logo: new URL('./assets/customer-logos/hust.png', import.meta.url).href, kind: 'university' },
  { id: 'beike', name: '贝壳找房', legalName: '贝壳找房（北京）科技有限公司', logo: new URL('./assets/customer-logos/beike.png', import.meta.url).href, kind: 'company' },
  { id: 'tongji', name: '同济大学', legalName: '同济大学', logo: new URL('./assets/customer-logos/tongji.png', import.meta.url).href, kind: 'university' },
  { id: 'supermap', name: '超图软件', legalName: '北京超图软件股份有限公司', logo: new URL('./assets/customer-logos/supermap.png', import.meta.url).href, kind: 'company' },
  { id: 'westlake', name: '西湖大学', legalName: '西湖大学', logo: new URL('./assets/customer-logos/westlake.png', import.meta.url).href, kind: 'university' },
  { id: 'sysu', name: '中山大学', legalName: '中山大学', logo: new URL('./assets/customer-logos/sysu.png', import.meta.url).href, kind: 'university' },
  { id: 'jd-donghong', name: '京东东鸿', legalName: '北京京东东鸿管理咨询有限公司', logo: new URL('./assets/customer-logos/jd-donghong.png', import.meta.url).href, kind: 'company' },
  { id: 'nudt', name: '国防科技大学', legalName: '国防科技大学', logo: new URL('./assets/customer-logos/nudt.png', import.meta.url).href, kind: 'university' },
  { id: 'mahua', name: '开心麻花', legalName: '北京开心麻花演艺经纪有限公司', logo: new URL('./assets/customer-logos/mahua.png', import.meta.url).href, kind: 'company' },
  { id: 'csu', name: '中南大学', legalName: '中南大学', logo: new URL('./assets/customer-logos/csu.png', import.meta.url).href, kind: 'university' },
  { id: 'miniworld', name: '迷你创想', legalName: '迷你创想科技（深圳）有限公司', logo: new URL('./assets/customer-logos/miniworld.png', import.meta.url).href, kind: 'company' },
  { id: 'szu', name: '深圳大学', legalName: '深圳大学', logo: new URL('./assets/customer-logos/szu.png', import.meta.url).href, kind: 'university' },
  { id: 'lzu', name: '兰州大学', legalName: '兰州大学', logo: new URL('./assets/customer-logos/lzu.png', import.meta.url).href, kind: 'university' },
  { id: 'cau', name: '中国农业大学', legalName: '中国农业大学', logo: new URL('./assets/customer-logos/cau.png', import.meta.url).href, kind: 'university' },
  { id: 'modern-express', name: '现代快报', legalName: '江苏现代快报传媒有限公司', logo: new URL('./assets/customer-logos/modern-express.png', import.meta.url).href, kind: 'company' },
  { id: 'zuel', name: '中南财经政法大学', legalName: '中南财经政法大学', logo: new URL('./assets/customer-logos/zuel.png', import.meta.url).href, kind: 'university' },
  { id: 'i-at', name: '阿尔特', legalName: '阿尔特汽车技术股份有限公司', logo: new URL('./assets/customer-logos/i-at.png', import.meta.url).href, kind: 'company' },
  { id: 'zjnu', name: '浙江师范大学', legalName: '浙江师范大学', logo: new URL('./assets/customer-logos/zjnu.png', import.meta.url).href, kind: 'university' },
]

export const loginCustomerRows: LoginCustomer[][] = [
  loginCustomers.slice(0, 7),
  loginCustomers.slice(7, 14),
  loginCustomers.slice(14),
]
