import type { OfficeDataSource } from '@pixoffice/protocol/dashboard'
import { ExampleOfficeDataSource } from './demoSource.ts'

export function createOfficeDataSource(): OfficeDataSource {
  return new ExampleOfficeDataSource()
}
