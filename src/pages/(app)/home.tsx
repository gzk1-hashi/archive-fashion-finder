/**
 * /home — the signed-in front door. Deliberately thin: the product is the
 * hunts board. (Visual design/theme is scheduled separately — see NOTES.md.)
 */

import { Link } from 'react-router-dom'
import { useAuthProfileReady } from 'deepspace'
import { buttonVariants } from '@/components/ui'
import { APP_NAME } from '../../constants'

export default function HomePage() {
  const { isSignedIn, user } = useAuthProfileReady({ requireUser: true })

  return (
    <div className="mx-auto flex min-h-full max-w-2xl flex-col justify-center gap-5 px-6 py-16 text-foreground">
      <p className="text-xs uppercase tracking-widest text-muted-foreground">{APP_NAME}</p>
      <h1 className="text-3xl font-semibold tracking-tight">Find the exact archive piece, in every market that has it.</h1>
      <p className="text-muted-foreground">
        Tell it the designer, piece and season. It searches US resale sites in English and Japanese resale sites in Japanese —
        where most archive stock actually is — prices every listing door-to-door, and puts the real candidates on a live board.
      </p>
      <div>
        <Link to="/hunts" className={buttonVariants()}>
          {isSignedIn ? 'Open your hunts' : 'Sign in to start a hunt'}
        </Link>
      </div>
      {isSignedIn && user && <p className="text-xs text-muted-foreground">Signed in as {user.name ?? user.email}</p>}
    </div>
  )
}
