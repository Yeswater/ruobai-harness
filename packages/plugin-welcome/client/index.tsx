import type { ClientApi } from '@ruobai/client-api'

/** Client half, bundled by client-modules and executed in the browser. */
export default function register(api: ClientApi) {
  api.slots.register('sidebar.footer', {
    id: 'welcome.badge',
    order: 10,
    component: () => <span className="chip">client plugin</span>,
  })

  api.slots.register('details.side', {
    id: 'welcome.card',
    order: 10,
    component: () => (
      <>
        <div className="detail-section">Client plugin</div>
        <div className="detail-note">
          这个卡片由 @ruobai/plugin-welcome 的 client 入口提供，运行时由 client-modules 打包后加载。
        </div>
      </>
    ),
  })
}
