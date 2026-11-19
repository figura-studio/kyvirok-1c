import assert from 'node:assert/strict'
import test from 'node:test'
import { makeReviews } from '../changes.mjs'

const entitySet = 'Document_Заказ'
const key = 'e653f2d7-8a8e-4611-a839-c51aa596822f'
const accepted = async () => ({action:'accept',content:{confirm:true}})
const plan = {connection:'demo',entitySet,operation:'create',fields:{Комментарий:'проверка'}}
function fixture(policy = {demo:{[entitySet]:{create:['Комментарий','Товары']}}}, guard) {
  const state = {gets:0,writes:0,networkCalls:0,record:{Ref_Key:key,Posted:false,Комментарий:'проверка'}}
  const handle = {
    async create(payload, opts) {
      state.writes++
      assert.equal(opts.retry,false)
      if (state.writeError) throw new Error('connection lost')
      return {Ref_Key:key,...payload}
    },
    async get() { state.gets++; if (state.readError) throw new Error('read failed'); return state.record },
  }
  const pool = { async get() {
    state.networkCalls++
    return {client:{entity:()=>handle}, index:{entitySetToType:{[entitySet]:entitySet},schemas:{
      [entitySet]:{properties:{Комментарий:{type:'Edm.String'},Posted:{type:'Edm.Boolean'},
        Товары:{type:'Collection(StandardODATA.Line)'}}},
      Line:{properties:{Количество:{type:'Edm.Int32'}}},
    }}}
  }}
  return {state,reviews:makeReviews(pool,policy,guard)}
}

test('no write policy and create-only policy reject forbidden operations before network', async () => {
  const empty = fixture({})
  await assert.rejects(empty.reviews.preview(plan),/не разрешён/)
  assert.equal(empty.state.networkCalls,0)
  const {reviews,state} = fixture()
  await assert.rejects(reviews.preview({...plan,operation:'update',key}),/Операция недоступна/)
  assert.equal(state.networkCalls,0)
  await assert.rejects(reviews.preview({...plan,fields:{Posted:true}}),/Поле запрещено/)
  await assert.rejects(reviews.preview({...plan,fields:{Товары:[{Unknown:1}]}}),/Недопустимое поле/)
  await reviews.preview(plan)
  assert.equal(state.writes,0)
})

test('each refusal has a reason, consumes the preview and never writes', async () => {
  const {reviews,state} = fixture()
  for (const [answer,reason] of [
    [{action:'decline'},'decline'], [{action:'cancel'},'cancel'],
    [{action:'accept',content:{confirm:false}},'unchecked'], [{action:'accept',content:{}},'unchecked'],
    [{action:'unsupported'},'unsupported'], [{action:'error'},'error'], [true,'error'],
  ]) {
    const {data} = await reviews.preview(plan)
    assert.equal((await reviews.apply(data.reviewId,async()=>answer)).data.reason,reason)
    await assert.rejects(reviews.apply(data.reviewId,accepted),/уже использован/)
  }
  assert.equal(state.writes,0)
})

test('expiry before and during confirmation prevents writes', async t => {
  let now = 1_000_000
  t.mock.method(Date,'now',()=>now)
  const {reviews,state} = fixture()
  const first = await reviews.preview(plan)
  now += 300_001
  await assert.rejects(reviews.apply(first.data.reviewId,()=>assert.fail('expired preview requested approval')),/истёк/)
  const second = await reviews.preview(plan)
  await assert.rejects(reviews.apply(second.data.reviewId,async()=>{ now+=300_001; return accepted() }),/Время подтверждения/)
  assert.equal(state.writes,0)
})

test('policy revocation during human confirmation prevents the write', async () => {
  let revoked = false
  const {reviews,state} = fixture(undefined,()=>{ if(revoked) throw new Error('policy changed') })
  const preview = await reviews.preview(plan)
  await assert.rejects(reviews.apply(preview.data.reviewId,async()=>{revoked=true;return accepted()}),/policy changed/)
  assert.equal(state.writes,0)
})

test('readback compares submitted values, table rows and Posted; read failure stays saved', async () => {
  const {reviews,state} = fixture()
  state.record.Товары = [{Количество:2,LineNumber:1}]
  const fields = {Комментарий:'проверка',Товары:[{Количество:2}]}
  const preview = await reviews.preview({...plan,fields})
  fields.Товары[0].Количество = 999 // Cannot alter the stored plan after preview.
  assert.equal((await reviews.apply(preview.data.reviewId,accepted)).data.verification.state,'verified')
  state.record = {...state.record,Posted:true,Комментарий:'изменено сервером'}
  const changed = await reviews.preview(plan)
  const changedResult = await reviews.apply(changed.data.reviewId,accepted)
  assert.deepEqual(changedResult.data.verification.differentFields,['Комментарий','Posted'])
  assert.equal(changedResult.data.verification.overview.проведение,'Проведён')
  state.readError = true
  const failed = await reviews.preview(plan)
  const result = await reviews.apply(failed.data.reviewId,accepted)
  assert.equal(result.data.state,'saved')
  assert.equal(result.data.verification.state,'unavailable')
  assert.equal(state.writes,3)
})

test('uncertain creation consumes the preview without an automatic retry', async () => {
  const {reviews,state} = fixture()
  state.writeError = true
  const preview = await reviews.preview(plan)
  await assert.rejects(reviews.apply(preview.data.reviewId,accepted),/Результат записи не подтверждён/)
  await assert.rejects(reviews.apply(preview.data.reviewId,accepted),/уже использован/)
  assert.equal(state.writes,1)
  assert.equal(state.gets,0)
})
