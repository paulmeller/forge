'use client';

import { useState } from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

/**
 * Target-repo input for the composer. With an installation repo list it's a
 * picker (single Select or multi checkboxes); without one it degrades to the
 * free-text inputs. Either way the form receives `targetRepos` as text, so
 * the server contract (parseRepoList) is unchanged.
 */
export function RepoPicker({
  mode,
  availableRepos,
  error,
}: {
  mode: 'single' | 'multi';
  availableRepos: string[];
  error?: string;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [freeText, setFreeText] = useState('');
  const hasList = availableRepos.length > 0;

  const label = mode === 'multi' ? 'Target repositories' : 'Target repository';
  const submittedValue = mode === 'multi' ? selected.join('\n') : (selected[0] ?? '');

  function toggle(repo: string) {
    setSelected((prev) =>
      prev.includes(repo) ? prev.filter((r) => r !== repo) : [...prev, repo],
    );
  }

  return (
    <div>
      <Label id="targetRepos-label" htmlFor="targetRepos">
        {label}
      </Label>
      {hasList ? (
        <>
          {mode === 'single' ? (
            <Select
              value={selected[0] ?? ''}
              onValueChange={(v) => setSelected([v])}
            >
              <SelectTrigger
                id="targetRepos"
                className="font-mono text-sm"
                aria-describedby={error ? 'targetRepos-error' : undefined}
              >
                <SelectValue placeholder="Pick a repo" />
              </SelectTrigger>
              <SelectContent>
                {availableRepos.map((repo) => (
                  <SelectItem key={repo} value={repo} className="font-mono text-sm">
                    {repo}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div
              role="group"
              aria-labelledby="targetRepos-label"
              aria-describedby={error ? 'targetRepos-error' : undefined}
              className="mt-1 max-h-48 overflow-y-auto rounded-md border"
            >
              {availableRepos.map((repo) => (
                <label
                  key={repo}
                  className="flex cursor-pointer items-center gap-2 border-b px-3 py-2 font-mono text-sm last:border-b-0 hover:bg-accent"
                >
                  <input
                    type="checkbox"
                    className="accent-checkbox h-4 w-4"
                    checked={selected.includes(repo)}
                    onChange={() => toggle(repo)}
                  />
                  {repo}
                </label>
              ))}
            </div>
          )}
          <input type="hidden" name="targetRepos" value={submittedValue} />
          <p className="mt-1 text-xs text-muted-foreground">
            {mode === 'multi'
              ? `${selected.length} selected — from your GitHub App installation.`
              : 'From your GitHub App installation.'}
          </p>
        </>
      ) : (
        <>
          {mode === 'single' ? (
            <Input
              id="targetRepos"
              name="targetRepos"
              placeholder="acme/api"
              className="font-mono text-sm"
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              aria-describedby={error ? 'targetRepos-error' : undefined}
            />
          ) : (
            <Textarea
              id="targetRepos"
              name="targetRepos"
              rows={6}
              placeholder="acme/api&#10;acme/web&#10;acme/mobile"
              className="font-mono text-sm"
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              aria-describedby={error ? 'targetRepos-error' : undefined}
            />
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {mode === 'multi' ? (
              <>
                One <span className="font-mono">owner/repo</span> per line. Commas or whitespace
                also work.
              </>
            ) : (
              'The Planner emits one Task against this repo.'
            )}
          </p>
        </>
      )}
      {error ? (
        <p id="targetRepos-error" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
