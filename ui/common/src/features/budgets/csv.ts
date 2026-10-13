/** The burn Table view's CSV (plan feat-budget-burn F1, CEO X8): raw numbers, so a spreadsheet can add them up. */
import type { CsvColumn } from '@/features/tokenops/csv'
import type { TableRow as Row } from './burn'
import { copy } from './copy'

export const BURN_CSV: CsvColumn<Row>[] = [
  { header: copy.tableDate, value: (r) => r.date },
  { header: copy.tableSpend, value: (r) => (r.low === null ? r.spend : null) },
  { header: copy.tableCumulative, value: (r) => (r.low === null ? r.cumulative : null) },
  { header: copy.tableLeft, value: (r) => r.left },
  { header: copy.tablePace, value: (r) => r.pace },
  { header: copy.tableLow, value: (r) => r.low },
  { header: copy.tableHigh, value: (r) => r.high },
  { header: copy.tableSpike, value: (r) => (r.spike ? 'yes' : '') },
]
