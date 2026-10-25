/** Minimal client-half fixture for the client-modules test. */
export default function register(api) {
  api.slots.register('sidebar.footer', {
    id: 'fixture.badge',
    component: () => <span className="chip">client fixture</span>,
  })
}
