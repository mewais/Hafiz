// RequestShaper: rewrites one outgoing model request for a session. Two implementations share
// ConversationShaper: `embedded-proxy` (wire level, stable host API) and `transform-hooks`
// (Kilo's experimental chat.*.transform hooks). Both fail open: on any error the request is
// passed through unchanged.

export type ShaperKind = 'embedded-proxy' | 'transform-hooks'

export interface RequestShaper<Req> {
  readonly kind: ShaperKind
  shape(request: Req): Promise<Req>
}

/** `host.kilo.shaper` (or the plugin option `shaper`). */
export type ShaperSetting = 'proxy' | 'hooks' | 'auto'
