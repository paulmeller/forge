'use client';

import { useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { parseLabelsInput } from '@/lib/github-issue-create';

import { createIssue } from './actions';

export function NewIssueDialog({ owner, repo }: { owner: string; repo: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [labelsText, setLabelsText] = useState('');
  const [titleError, setTitleError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function reset() {
    setTitle('');
    setBody('');
    setLabelsText('');
    setTitleError(null);
    setSubmitError(null);
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) reset();
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) {
      setTitleError('Title is required');
      return;
    }
    setTitleError(null);
    setSubmitError(null);

    startTransition(async () => {
      const result = await createIssue(owner, repo, {
        title: trimmed,
        body: body.trim() || undefined,
        labels: parseLabelsInput(labelsText),
      });
      if (!result.ok) {
        setSubmitError(result.error);
        return;
      }
      setOpen(false);
      reset();
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          + New issue
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>New issue</DialogTitle>
            <DialogDescription>
              Files a real issue on GitHub. It won&apos;t start any work — you&apos;ll still
              click &quot;Work on it&quot; whenever you&apos;re ready.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-1.5">
              <Label htmlFor="new-issue-title">Title</Label>
              <Input
                id="new-issue-title"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  if (titleError) setTitleError(null);
                }}
                autoFocus
              />
              {titleError ? <p className="text-xs text-destructive">{titleError}</p> : null}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-issue-body">Description</Label>
              <Textarea
                id="new-issue-body"
                rows={5}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="new-issue-labels">Labels</Label>
              <Input
                id="new-issue-labels"
                placeholder="bug, p1"
                value={labelsText}
                onChange={(e) => setLabelsText(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">Comma-separated, optional.</p>
            </div>
            {submitError ? <p className="text-xs text-destructive">{submitError}</p> : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => handleOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Spinner data-icon="inline-start" /> : null}
              Create issue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
