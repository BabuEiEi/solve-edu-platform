import { unwrap } from './errors.js'

export function createAuthService(client) {
  const redirectTo = `${window.location.origin}${window.location.pathname}`
  return {
    async getSession() {
      return unwrap(await client.auth.getSession(), 'auth.getSession')?.session ?? null
    },
    onChange(callback) {
      return client.auth.onAuthStateChange((_event, session) => callback(session))
    },
    async signInWithPassword(email, password) {
      return unwrap(await client.auth.signInWithPassword({ email: email.trim(), password }), 'auth.signIn')
    },
    /** full_name is display-only metadata; role/status are NEVER taken from metadata. */
    async signUp(email, password, fullName) {
      return unwrap(
        await client.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { full_name: String(fullName ?? '').trim() }, emailRedirectTo: redirectTo },
        }),
        'auth.signUp'
      )
    },
    async signInWithGoogle() {
      return unwrap(
        await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } }),
        'auth.google'
      )
    },
    async signOut() {
      const { error } = await client.auth.signOut({ scope: 'local' })
      if (error) console.warn('[auth] signOut', error.message)
    },
  }
}
