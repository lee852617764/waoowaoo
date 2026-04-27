import { describe, expect, it } from 'vitest'
import { ROUTE_CATALOG } from '../../../contracts/route-catalog'

describe('api contract - user project routes (catalog)', () => {
  it('includes user api-config route in user-project-routes contract group', () => {
    const entry = ROUTE_CATALOG.find((item) => item.routeFile === 'src/app/api/user/api-config/route.ts')
    expect(entry).toMatchObject({
      category: 'user',
      contractGroup: 'user-project-routes',
    })
  })
})
