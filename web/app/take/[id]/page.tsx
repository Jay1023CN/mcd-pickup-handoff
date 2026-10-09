import { FriendHandoff } from "../../ui/friend-handoff";
export default async function TakePage({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <FriendHandoff key={id} id={id} />; }
