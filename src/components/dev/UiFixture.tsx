/**
 * Every shadcn primitive the site uses, rendered the way the site will use it, so a token problem shows up
 * here before it shows up on a page. Served only by the dev server at /dev/ui (src/pages/dev/[fixture].astro)
 * and exercised by tests/ui-fixture.spec.ts; the production build emits no page for it.
 */
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

const touch = "min-h-11 min-w-11"

export function UiFixture() {
  return (
    <div data-fixture className="grid gap-10">
      <section aria-labelledby="fx-buttons" className="grid gap-4">
        <h2 id="fx-buttons" className="prose-serif text-[1.6rem] leading-tight">Buttons</h2>
        <div className="flex flex-wrap items-center gap-3">
          <Button className={touch}>Default</Button>
          <Button variant="outline" className={touch}>Outline</Button>
          <Button variant="secondary" className={touch}>Secondary</Button>
          <Button variant="ghost" className={touch}>Ghost</Button>
          <Button variant="link" className={`${touch} underline`}>Link</Button>
          <Button variant="outline" size="icon" className={touch} aria-label="Icon only">
            <span aria-hidden="true">+</span>
          </Button>
        </div>
      </section>

      <Separator />

      <section aria-labelledby="fx-card" className="grid gap-4">
        <h2 id="fx-card" className="prose-serif text-[1.6rem] leading-tight">Card</h2>
        <Card className="max-w-[40rem]">
          <CardHeader>
            <CardTitle className="prose-serif text-[1.375rem]">Live engineering data</CardTitle>
            <CardDescription>
              Delivered live-data views, a personal timeline, and freshness-aware Redis caching.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Badge variant="outline">typescript</Badge>
            <Badge variant="outline">redis</Badge>
            <Badge variant="secondary">In production</Badge>
          </CardContent>
          <CardFooter>
            <Button variant="link" className={`${touch} px-0 underline`}>Read case study →</Button>
          </CardFooter>
        </Card>
      </section>

      <Separator />

      <section aria-labelledby="fx-alert" className="grid gap-4">
        <h2 id="fx-alert" className="prose-serif text-[1.6rem] leading-tight">Alert</h2>
        <Alert role="note" className="max-w-[40rem]">
          <AlertTitle>Evidence boundary</AlertTitle>
          <AlertDescription>
            This note describes the public experiment. It makes no claim about a model's task success.
          </AlertDescription>
        </Alert>
      </section>

      <section aria-labelledby="fx-table" className="grid gap-4">
        <h2 id="fx-table" className="prose-serif text-[1.6rem] leading-tight">Table</h2>
        <Table className="max-w-[40rem]">
          <TableHeader>
            <TableRow>
              <TableHead>Case</TableHead>
              <TableHead>Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Correct fix</TableCell>
              <TableCell>Accepted</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>Plausible patch</TableCell>
              <TableCell>Rejected by frozen tests</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </section>
    </div>
  )
}
