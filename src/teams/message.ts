// Port of ciel/message.go: the subset of a Teams chat message audee reads; unknown fields are ignored.
export type Identity = { id: string; displayName?: string };

export type Mention = { mentioned?: { user?: Identity | null } | null };

export type ChatMessage = {
  id: string;
  chatId?: string;
  messageType?: string;
  createdDateTime?: string;
  from?: { user?: Identity | null } | null;
  body: { contentType?: string | null; content?: string };
  mentions?: Mention[];
};

export function sender(m: ChatMessage): Identity | undefined {
  const user = m.from?.user;
  return user === null || user === undefined ? undefined : user;
}

// The principal scheme: teams:<message.from.user.id>.
export function principalOf(m: ChatMessage): string | undefined {
  const s = sender(m);
  return s === undefined || s.id === '' ? undefined : `teams:${s.id}`;
}
