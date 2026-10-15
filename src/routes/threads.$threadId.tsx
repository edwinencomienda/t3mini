import { createFileRoute } from '@tanstack/react-router'
import { Workspace } from '../components/Workspace'
export const Route = createFileRoute('/threads/$threadId')({ component: ThreadPage })
function ThreadPage() {
  const { threadId } = Route.useParams()
  return <Workspace threadId={threadId} />
}
