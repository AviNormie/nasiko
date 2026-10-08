/**
 * A module's sub-pages as one row of links under its page header (Workflows: Deployed · Drafts · Runs; Agents: All
 * agents · Your agents · Builds), so a module never needs a second sidebar.
 */
import { Link, type LinkProps } from '@tanstack/react-router'
import { TopBar } from '@/app/shell/TopBar'
import { Button } from '@/components/ui/button'

export interface Section {
  to: NonNullable<LinkProps['to']>
  label: string
}

export function SectionNav({
  label,
  sections,
  current,
}: {
  /** The landmark's name (the module). */
  label: string
  sections: readonly Section[]
  current: Section['to']
}) {
  const at = sections.find((s) => s.to === current)
  return (
    <>
      {/* The module's first section is its nav item ("Agents"); the others are a level below it ("Agents › Builds"). */}
      <TopBar trail={at && at !== sections[0] ? [at.label] : []} />
      <nav aria-label={label} className="flex flex-wrap gap-1">
        {sections.map((s) => (
          <Button
            key={s.to}
            asChild
            size="sm"
            variant={s.to === current ? 'secondary' : 'ghost'}
            className={s.to === current ? 'font-medium' : 'font-normal text-muted-foreground'}
          >
            <Link to={s.to} aria-current={s.to === current ? 'page' : undefined}>
              {s.label}
            </Link>
          </Button>
        ))}
      </nav>
    </>
  )
}
