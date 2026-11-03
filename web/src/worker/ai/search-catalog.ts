export type KeyMode = 'required' | 'optional' | 'none'
export interface ProviderSpec {
  id: string
  name: string
  description: string
  officialWebsite?: string
  apiKeyWebsite?: string
  basicAuth: boolean
  search?: { defaultBaseUrl?: string; keyMode: KeyMode }
  fetch?: { defaultBaseUrl?: string; keyMode: KeyMode }
}
const p = (
  id: string,
  name: string,
  description: string,
  spec: Partial<ProviderSpec> & Pick<ProviderSpec, 'basicAuth'>,
): ProviderSpec => ({ id, name, description, ...spec })
export const PROVIDERS: readonly ProviderSpec[] = [
  p(
    'zhipu',
    '智谱 Zhipu',
    '智谱 GLM Web Search，提供联网搜索与实时信息检索。',
    {
      basicAuth: false,
      officialWebsite:
        'https://docs.bigmodel.cn/cn/guide/tools/web-sear' + 'ch',
      apiKeyWebsite:
        'https://www.bigmodel.cn/invite?icode=X2d48dEyAbB' +
        'OUJCLpZmYJUjPr3uHog9F4g5tjuOUqno%3D',
      search: {
        defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4/web_search',
        keyMode: 'required',
      },
    },
  ),
  p('tavily', 'Tavily', '专为 LLM 优化的搜索引擎。', {
    basicAuth: false,
    officialWebsite: 'https://tavily.com',
    apiKeyWebsite: 'https://app.tavily.com/home',
    search: { defaultBaseUrl: 'https://api.tavily.com', keyMode: 'required' },
  }),
  p('searxng', 'SearXNG', '可自托管的免费互联网元搜索引擎，聚合多个搜索源。', {
    basicAuth: true,
    officialWebsite: 'https://docs.searxng.org',
    search: { defaultBaseUrl: 'http://localhost:8080', keyMode: 'none' },
  }),
  p('exa', 'Exa', '为 AI 应用设计的神经搜索 API，擅长语义检索高质量网页。', {
    basicAuth: false,
    officialWebsite: 'https://exa.ai',
    apiKeyWebsite: 'https://dashboard.exa.ai/api-keys',
    search: { defaultBaseUrl: 'https://api.exa.ai', keyMode: 'required' },
  }),
  p(
    'exa-mcp',
    'Exa MCP',
    '通过 Exa MCP Server 免费使用 Exa 搜索，不填密钥也能用。',
    {
      basicAuth: false,
      officialWebsite: 'https://exa.ai',
      search: { defaultBaseUrl: 'https://mcp.exa.ai/mcp', keyMode: 'optional' },
    },
  ),
  p(
    'bocha',
    '博查 Bocha',
    '面向 AI 场景的中文搜索 API，提供实时网页与结构化结果。',
    {
      basicAuth: false,
      officialWebsite: 'https://bochaai.com',
      apiKeyWebsite: 'https://open.bochaai.com/overview',
      search: {
        defaultBaseUrl: 'https://api.bochaai.com',
        keyMode: 'required',
      },
    },
  ),
  p(
    'querit',
    'Querit',
    'Querit 搜索与内容接口，用于关键词检索与网页正文提取。',
    {
      basicAuth: false,
      officialWebsite: 'https://querit.ai',
      apiKeyWebsite: 'https://www.querit.ai/en/dashboard/api-keys',
      search: { defaultBaseUrl: 'https://api.querit.ai', keyMode: 'required' },
      fetch: { defaultBaseUrl: 'https://api.querit.ai', keyMode: 'required' },
    },
  ),
  p('brave', 'Brave Search', 'Brave 独立索引的网页搜索 API。', {
    basicAuth: false,
    officialWebsite: 'https://brave.com/search/api/',
    apiKeyWebsite: 'https://api-dashboard.search.brave.com/app/keys',
    search: {
      defaultBaseUrl: 'https://api.search.brave.com',
      keyMode: 'required',
    },
  }),
  p(
    'parallel',
    'Parallel',
    '面向 AI 智能体的网页搜索 API，返回按相关性排序的链接与高密度摘录。',
    {
      basicAuth: false,
      officialWebsite: 'https://parallel.ai',
      apiKeyWebsite: 'https://platform.parallel.ai',
      search: {
        defaultBaseUrl: 'https://api.parallel.ai',
        keyMode: 'required',
      },
    },
  ),
  p('jina', 'Jina', 'Jina Reader 搜索与阅读接口，用于检索并提取网页正文。', {
    basicAuth: false,
    officialWebsite: 'https://jina.ai/reader',
    apiKeyWebsite: 'https://jina.ai',
    search: { defaultBaseUrl: 'https://s.jina.ai', keyMode: 'required' },
    fetch: { defaultBaseUrl: 'https://r.jina.ai', keyMode: 'optional' },
  }),
  p(
    'firecrawl',
    'Firecrawl',
    'Firecrawl 网页抓取与搜索服务，支持将网页转换为 Markdown 格式。',
    {
      basicAuth: false,
      officialWebsite: 'https://firecrawl.dev',
      apiKeyWebsite: 'https://firecrawl.dev/app/api-keys',
      search: {
        defaultBaseUrl: 'https://api.firecrawl.dev',
        keyMode: 'optional',
      },
      fetch: {
        defaultBaseUrl: 'https://api.firecrawl.dev',
        keyMode: 'optional',
      },
    },
  ),
  p(
    'fetch',
    '内置直连',
    '内置 URL 获取，直接请求网页并提取正文，不需要密钥。',
    { basicAuth: false, fetch: { keyMode: 'none' } },
  ),
]
export const SEARCH_ORDER = [
  'zhipu',
  'tavily',
  'searxng',
  'exa',
  'exa-mcp',
  'bocha',
  'querit',
  'brave',
  'parallel',
  'jina',
  'firecrawl',
]
export const FETCH_ORDER = ['querit', 'fetch', 'jina', 'firecrawl']
export const DEFAULTS: Record<'search' | 'fetch', string> = {
  search: 'exa-mcp',
  fetch: 'jina',
}
