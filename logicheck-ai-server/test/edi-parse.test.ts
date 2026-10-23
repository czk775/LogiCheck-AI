/* ============================================================
   EDIFACT 解析器测试（真实报文文本）
   ============================================================ */

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseEdifact, assertSupportedType, EdiParseError, findSegments } from '../src/modules/parsing/edi/parse.ts'

const INVOIC = `UNB+UNOC:3+SENDERGLN+RECIPGLN+260101:1200+INVREF001++EANCOM'
UNH+M001+INVOIC:D:96A:UN:EAN008'
BGM+380+INV-2026-0042+9'
DTM+137:20260105:102'
NAD+BY+Buyer GmbH++Main St 1+Berlin++10115+DE'
NAD+SU+Supplier Co., Ltd.++Nanjing Rd 88+Shanghai++200001+CN'
CUX+2:USD:4'
LIN+1++PRODUCT-A:SA:: model LS-B200'
QTY+47:1000:PCE'
PRI+AAA:12.50:::EA'
MOA+203:12500.00'
UNT+9+M001'
UNZ+1+INVREF001'`

const DESADV = `UNB+UNOC:3+SENDERGLN+RECIPGLN+260102:0900+DSPREF009'
UNH+M002+DESADV:D:96A:UN:EAN008'
BGM+351+DSP-2026-0091+9'
DTM+11:20260106:102'
NAD+CZ+Consignee Ltd++Hafenstr 5+Hamburg++20457+DE'
NAD+SU+Supplier Co., Ltd.++Nanjing Rd 88+Shanghai++200001+CN'
LIN+1++PRODUCT-A:SA'
QTY+12:980:PCE'
MEA+AAE+G+KGM:420.5'
UNT+9+M002'
UNZ+1+DSPREF009'`

const IFTMIN = `UNB+UNOC:3+SENDERGLN+RECIPGLN+260103:1000+TRPREF100'
UNH+M003+IFTMIN:D:96A:UN'
BGM+230+BK-2026-1007+9'
DTM+137:20260103:102'
RFF+ON:PO-9981'
TOD+6+FOB'
UNT+8+M003'
UNZ+1+TRPREF100'`

test('E1 解析 INVOIC：信封 + 消息头 + 段结构', () => {
  const msg = parseEdifact(INVOIC)
  assert.equal(msg.messageType, 'INVOIC')
  assert.equal(msg.messageVersion, 'D')
  assert.equal(msg.sender, 'SENDERGLN')
  assert.equal(msg.recipient, 'RECIPGLN')
  assert.equal(msg.segments[0].tag, 'UNB')
  assert.equal(msg.segments[1].tag, 'UNH')
  assert.ok(msg.segments.some((s) => s.tag === 'LIN'))
})

test('E3 解析 IFTMIN：运输订单报文 + 类型校验通过', () => {
  const msg = parseEdifact(IFTMIN)
  assert.equal(msg.messageType, 'IFTMIN')
  assert.equal(msg.messageVersion, 'D')
  assert.equal(assertSupportedType(msg), 'IFTMIN')
  const rff = findSegments(msg, 'RFF')[0]
  assert.equal(rff.elements[0][0], 'ON')
  assert.equal(rff.elements[0][1], 'PO-9981')
  const tod = findSegments(msg, 'TOD')[0]
  assert.equal(tod.elements[1][0], 'FOB')
})

test('E4 解析 DESADV：通知与发货结构', () => {
  const msg = parseEdifact(DESADV)
  assert.equal(msg.messageType, 'DESADV')
  assert.equal(assertSupportedType(msg), 'DESADV')
})

test('E2 段元素与成分切分', () => {
  const msg = parseEdifact(INVOIC)
  const bgm = findSegments(msg, 'BGM')[0]
  assert.equal(bgm.elements[0][0], '380')
  assert.equal(bgm.elements[1][0], 'INV-2026-0042')
  const qty = findSegments(msg, 'QTY')[0]
  assert.deepEqual(qty.elements[0], ['47', '1000', 'PCE'])
  const moa = findSegments(msg, 'MOA')[0]
  assert.equal(moa.elements[0][1], '12500.00')
})

test('E5 DESADV 重量段 MEA 明细', () => {
  const msg = parseEdifact(DESADV)
  assert.equal(msg.messageType, 'DESADV')
  const mea = findSegments(msg, 'MEA')[0]
  assert.equal(mea.elements[0][0], 'AAE')
  assert.equal(mea.elements[1][0], 'G')
  assert.equal(mea.elements[2][1], '420.5')
})

test('E6 不支持的消息类型 → 明确报错', () => {
  const msg = parseEdifact(`UNB+UNOC:3+A+B+260101:1200+X'
UNH+M999+ORDERS:D:96A:UN'
BGM+220+PO-1'
UNT+3+M999'
UNZ+1+X'`)
  assert.throws(
    () => assertSupportedType(msg),
    (err: unknown) => err instanceof EdiParseError && err.code === 'unsupported_message_type' && String((err as Error).message).includes('ORDERS'),
  )
})

test('E7 释放字符：?+ 是字面加号', () => {
  const msg = parseEdifact(`UNB+UNOC:3+A+B+260101:1200+X'
UNH+M1+IFTMIN:D:96A:UN'
BGM+230+BK?+1+9'
UNT+3+M1'
UNZ+1+X'`)
  const bgm = findSegments(msg, 'BGM')[0]
  assert.equal(bgm.elements[1][0], 'BK+1')
})

test('E8 空报文 / 无 UNH → 错误', () => {
  assert.throws(() => parseEdifact(''), (err: unknown) => err instanceof EdiParseError && err.code === 'empty_message')
  assert.throws(
    () => parseEdifact(`UNB+UNOC:3+A+B+260101:1200+X'
UNZ+1+X'`),
    (err: unknown) => err instanceof EdiParseError && err.code === 'missing_unh',
  )
})

test('E9 UNA 服务串自定义分隔符', () => {
  const msg = parseEdifact(`UNA:+.? '
UNB+UNOC:3+SENDER+RECIP+260101:1200:REF'
UNH+M001+IFTMIN:D:96A:UN'
BGM+230+BK-2026-1007+9'
UNT+8+M001'
UNZ+1+REF'`)
  assert.equal(msg.messageType, 'IFTMIN')
  const bgm = findSegments(msg, 'BGM')[0]
  assert.equal(bgm.elements[1][0], 'BK-2026-1007')
})
