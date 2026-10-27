/** Top-level destinations that are not tied to a chat session. */
export type FunctionView = 'wiki' | 'tools'

export type ToolTab = 'experts' | 'skills' | 'connectors'

export interface FunctionViewInfo {
  id: FunctionView
  label: string
  description: string
  badge?: string
}

export const FUNCTION_VIEWS: FunctionViewInfo[] = [
  {
    id: 'wiki',
    label: '知识库',
    description: '沉淀项目知识：页面、提案与检索。',
  },
  {
    id: 'tools',
    label: '专家·技能·连接器',
    description: '把常用角色、技能与外部工具装进会话。',
  },
]

export function functionViewInfo(id: FunctionView): FunctionViewInfo {
  return FUNCTION_VIEWS.find(item => item.id === id) ?? FUNCTION_VIEWS[0]!
}
