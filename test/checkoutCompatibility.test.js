import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { Order } from '../models/Order.js';
import User from '../models/User.js';
import Item from '../models/Item.js';
import StorefrontSettings from '../models/StorefrontSettings.js';
import { clearStorefrontSettingsCache } from '../utils/storefrontSettingsCache.js';
import { getPackPriceForItem } from '../utils/packPricing.js';
import { releaseUnpaidCashfreeCoupon } from '../utils/coupons.js';
import CouponRedemption from '../models/CouponRedemption.js';

// No real provider requests or database connections in this integration test.
process.env.RAZORPAY_KEY_ID = 'rzp_test_fixture';
process.env.RAZORPAY_KEY_SECRET = 'fixture-only';
process.env.CASHFREE_ENV = 'production';
process.env.CASHFREE_APP_ID = 'fixture-only';
process.env.CASHFREE_SECRET_KEY = 'fixture-only';
process.env.ACCESS_TOKEN_SECRET = 'fixture-access';
const { default: router, cashfreePayments } = await import('../routes/orderRoutes.js');
const { razorpay } = await import('../config/razorpay.js');

test('changing an unpaid Cashfree checkout releases only its coupon reservation', async (t) => {
  const removed = [];
  t.mock.method(CouponRedemption, 'deleteOne', async (filter) => removed.push(filter));
  const order = { _id: 'order', user: 'user', couponId: 'coupon', paymentProvider: 'cashfree', orderStatus: 'CANCELLED', paymentStatus: 'PENDING' };
  await releaseUnpaidCashfreeCoupon(order);
  assert.deepEqual(removed, [{ coupon: 'coupon', user: 'user', order: 'order' }]);
  for (const change of [{ paymentStatus: 'PAID' }, { paymentProvider: 'razorpay' }, { orderStatus: 'CONFIRMED' }]) {
    await releaseUnpaidCashfreeCoupon({ ...order, ...change });
  }
  assert.equal(removed.length, 1);
});

test('real order route preserves old Razorpay/COD, server prices Cashfree, and keeps address/phone guards', async (t) => {
  const uid = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  let user = { _id: uid, phone: '9876543210', tower: 'Legacy Tower', flat: '12' };
  const product = { _id: 'legacy-product', name: 'Chicken', category: 'Uncooked', price: 200 };
  const expectedTotal = getPackPriceForItem(product, 500) * 2 + 10;
  let razorpayCreates = 0, liveCreates = 0;
  const records = [];
  t.mock.method(User, 'findById', () => ({ select: () => ({ lean: async () => user }) }));
  t.mock.method(User, 'find', () => ({ select: () => ({ lean: async () => [] }) }));
  t.mock.method(Item.collection, 'find', () => ({ toArray: async () => [product] }));
  t.mock.method(StorefrontSettings, 'findOne', () => ({ lean: async () => ({ storeOpen: true, packagingFee: 10 }) }));
  t.mock.method(Order, 'create', async (snapshot) => {
    const order = new Order(snapshot);
    assert.equal(order.validateSync(), undefined);
    records.push(order);
    return order;
  });
  t.mock.method(razorpay.orders, 'create', async (request) => {
    razorpayCreates++;
    assert.equal(request.amount, Math.round(expectedTotal * 100));
    return { id: 'order_legacy' };
  });
  t.mock.method(cashfreePayments, 'resume', async () => null);
  t.mock.method(cashfreePayments, 'create', async (identity, snapshot, phone) => {
    liveCreates++;
    assert.match(identity.id, /^[a-f0-9]{24}$/);
    assert.equal(snapshot.totalAmount, expectedTotal);
    assert.equal(snapshot.deliveryAddress.tower, 'Legacy Tower');
    assert.equal(phone, '9876543210');
    return { paymentProvider: 'cashfree', amount: expectedTotal * 100, localOrderId: identity.id };
  });
  clearStorefrontSettingsCache();
  t.after(clearStorefrontSettingsCache);
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const token = jwt.sign({ id: uid }, process.env.ACCESS_TOKEN_SECRET);
  const send = async (body, path = '/orders/create') => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  const cart = { cartItems: [{ _id: product._id, selectedSize: 500, quantity: 2, price: 0.01 }] };
  const legacy = await send(cart);
  assert.equal(legacy.status, 200);
  assert.equal(legacy.data.razorpayOrderId, 'order_legacy');
  assert.equal(legacy.data.paymentProvider, undefined);
  assert.equal(legacy.data.amount, expectedTotal * 100);
  const cod = await send({ ...cart, paymentMethod: 'COD' });
  assert.equal(cod.status, 200);
  assert.equal(cod.data.requiresPayment, false);
  assert.equal(razorpayCreates, 1);
  const modern = { ...cart, paymentProvider: 'cashfree', requestId: randomUUID(), amount: 1 };
  assert.equal((await send(modern)).data.paymentProvider, 'cashfree');
  assert.equal(liveCreates, 1);
  assert.equal(records.length, 2);
  user = { _id: uid, phone: '9876543210', deliveryLocation: { latitude: 28.7, longitude: 77.3, serviceable: false, locationKey: 'gps' } };
  assert.equal((await send(modern)).data.code, 'LOCATION_NOT_SERVICEABLE');
  user = { _id: uid, phone: '9876543210' };
  assert.equal((await send(modern)).data.code, 'LOCATION_REQUIRED');
  user = { _id: uid, tower: 'Legacy Tower' };
  assert.equal((await send(modern)).data.code, 'PHONE_REQUIRED');
  assert.equal(liveCreates, 1);
  const cashfreeOrder = { _id: uid, user: uid, paymentProvider: 'cashfree', paymentStatus: 'PENDING' };
  t.mock.method(Order, 'findById', async () => cashfreeOrder);
  assert.equal((await send({ localOrderId: uid, paymentStatus: 'PAID' }, '/orders/payment-failed')).status, 409);
  assert.equal((await send({ localOrderId: uid, razorpay_order_id: 'other', razorpay_payment_id: 'other', razorpay_signature: 'fake' }, '/orders/verify')).status, 400);
});
