"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// https://stripe.com/docs/billing/subscriptions/payment
// Test 3D Secure 2: 4000002500003155
// Test failure: 4000000000000341
// Test VAT number IE6388047V
const debug_1 = __importDefault(require("debug"));
const moment_1 = __importDefault(require("moment"));
const debug = debug_1.default('checkout');
const credit_card_brands_1 = __importDefault(require("../data/credit_card_brands"));
const validate_vat_1 = __importDefault(require("./validate-vat"));
const util_1 = require("./util");
const tax_1 = require("./tax");
class Checkout {
    constructor(stripe) {
        if (!stripe) {
            throw new Error('You must provide a stripe instance');
        }
        if (typeof stripe !== 'object') {
            throw new Error('You must provide a stripe instance (not an api key)');
        }
        this.stripe = stripe;
    }
    async getSubscription(stripeCustomerId) {
        if (stripeCustomerId) {
            debug('fetching subscriptions');
            const customer = (await this.stripe.customers.retrieve(stripeCustomerId, { expand: ['invoice_settings.default_payment_method', 'subscriptions.data.default_payment_method'] }));
            return await this.parseSubscription(customer);
        }
        else {
            debug('no customer id');
            return await this.parseSubscription(null);
        }
    }
    async validateVatNumber(q) {
        const country = q.slice(0, 2);
        const number = q.slice(2);
        return await validate_vat_1.default(country, number);
    }
    async manageSubscription(stripeCustomerId, opts = {}) {
        const { plan, email, name, country, postcode, paymentMethod, coupon, trialDays, vat, taxOrigin, taxRates } = opts;
        // Maybe validate coupon
        if (coupon) {
            debug('validating coupon:', coupon);
            try {
                await this.stripe.coupons.retrieve(coupon);
            }
            catch (err) {
                throw new Error('Coupon not found');
            }
        }
        // Maybe validate vat number
        if (vat) {
            if (!await this.validateVatNumber(vat)) {
                throw new Error('Invalid vat number');
            }
        }
        const { tax_exempt, tax_id, tax_rate } = tax_1.getTax(country, vat, taxOrigin, taxRates);
        debug('tax status: tax_exempt=' + tax_exempt);
        let customer;
        // Retrieve customer
        if (stripeCustomerId) {
            debug('updating existing customer');
            try {
                customer = (await this.stripe.customers.retrieve(stripeCustomerId));
                await this.stripe.customers.update(stripeCustomerId, { name, email, tax_exempt: tax_exempt, address: { line1: '', country, postal_code: postcode } });
            }
            catch (err) {
                stripeCustomerId = null;
            }
        }
        // Create customer
        if (!stripeCustomerId) {
            debug('creating new customer');
            customer = await this.stripe.customers.create({ name, email, tax_exempt: tax_exempt, address: { line1: '', country, postal_code: postcode } });
            stripeCustomerId = customer.id;
        }
        // Maybe update tax id
        if (tax_id) {
            if (!customer.tax_ids.data.find(e => e.type == tax_id.type && e.value == tax_id.value)) {
                debug('adding tax id: ' + tax_id.type + ' ' + tax_id.value);
                await this.stripe.customers.createTaxId(stripeCustomerId, tax_id);
            }
            else {
                debug('tax id already exists');
            }
        }
        else {
            debug('removing tax id');
            for (const e of customer.tax_ids.data) {
                await this.stripe.customers.deleteTaxId(stripeCustomerId, e.id);
            }
        }
        // Maybe apply tax rates
        const default_tax_rates = [];
        if (tax_rate) {
            debug('adding tax rate: ' + tax_rate);
            default_tax_rates.push(tax_rate);
        }
        // Maybe attach a payment method (e.g. new subscription or change card) and set is as the default payment method for the customer
        if (paymentMethod) {
            const oldPaymentMethod = customer.invoice_settings ? customer.invoice_settings.default_payment_method : null;
            debug('attaching payment method');
            await this.stripe.paymentMethods.attach(paymentMethod, { customer: stripeCustomerId }); // add new card
            await this.stripe.customers.update(stripeCustomerId, {
                invoice_settings: {
                    default_payment_method: paymentMethod
                }
            });
            if (oldPaymentMethod) {
                debug('detach old payment method');
                await this.stripe.paymentMethods.detach(oldPaymentMethod);
            }
        }
        // Fetch subscription for customer
        if (customer.subscriptions.data.length > 0) {
            const sub = customer.subscriptions.data[0];
            debug('found subscription with status=' + sub.status);
            // Maybe change plan
            if (plan) {
                if (sub.plan.id !== plan) {
                    debug('update subscription plan:', plan);
                    let trial_end;
                    if (trialDays) {
                        trial_end = moment_1.default().add(trialDays, 'days').valueOf();
                    }
                    await this.stripe.subscriptions.update(sub.id, {
                        default_tax_rates,
                        coupon: coupon || undefined,
                        trial_end,
                        billing_cycle_anchor: 'now',
                        items: [{ id: sub.items.data[0].id, plan }],
                        off_session: true,
                    });
                }
                else {
                    debug('customer is already subscribed to plan:', plan);
                }
            }
            if (sub.status == 'incomplete') {
                const invoice = await this.stripe.invoices.retrieve(sub.latest_invoice, { expand: ['payment_intent'] });
                const paymentIntent = invoice.payment_intent;
                if (paymentIntent.status == 'requires_payment_method' || paymentIntent.status == 'requires_confirmation') {
                    try {
                        debug('attempting invoice again...');
                        await this.stripe.invoices.pay(invoice.id);
                    }
                    catch (err) {
                        debug('new attempt failed...', err.message);
                    }
                }
            }
            if (sub.status == 'past_due') {
                debug('attempt to pay latest invoice');
                await this.stripe.invoices.pay(sub.latest_invoice);
            }
        }
        else if (plan) { // allow creating a subscription with an existing default payment method!
            debug('creating new subscription');
            const sub = await this.stripe.subscriptions.create({
                default_tax_rates,
                coupon: coupon || undefined,
                trial_period_days: trialDays || undefined,
                customer: stripeCustomerId,
                items: [{ plan }],
                off_session: true,
            });
            if (sub.status === 'incomplete') {
                debug('failed to create new sub:', sub.status);
                // await this.stripe.subscriptions.del(sub.id); ???
            }
        }
        return stripeCustomerId;
    }
    /**
     * Cancel a subscription (default at period end).
     */
    async cancelSubscription(stripeCustomerId, atPeriodEnd = true) {
        const sub = await this.getSubscription(stripeCustomerId);
        if (sub.valid) {
            debug('canceling subscription atPeriodEnd=' + atPeriodEnd);
            const canceledSubscription = await this.stripe.subscriptions.update(sub.id, {
                cancel_at_period_end: atPeriodEnd
            });
            return canceledSubscription;
        }
        else {
            debug('no subscription to cancel');
            return null;
        }
    }
    /**
     * Reactivate a subscription that has been cancelled (if at period end).
     */
    async reactivateSubscription(stripeCustomerId) {
        const sub = await this.getSubscription(stripeCustomerId);
        if (sub.valid) {
            debug('reactivating subscription');
            await this.stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });
            return true;
        }
        else {
            debug('no subscription to reactivate');
            return false;
        }
    }
    /**
     * Delete a subscription immediately (e.g. when closing an account).
     */
    async deleteSubscription(stripeCustomerId) {
        const sub = await this.getSubscription(stripeCustomerId);
        if (sub.valid) {
            debug('deleting subscription');
            await this.stripe.subscriptions.del(sub.id);
            return true;
        }
        else {
            debug('no subscription to delete');
            return false;
        }
    }
    /**
     * Delete a subscription immediately (e.g. when closing an account).
     */
    async deleteCustomer(stripeCustomerId) {
        if (stripeCustomerId) {
            await this.stripe.customers.del(stripeCustomerId);
            return true;
        }
        else {
            debug('no customer id');
            return false;
        }
    }
    /**
     * List all receipts
     */
    async getReceipts(stripeCustomerId) {
        if (!stripeCustomerId) {
            debug('no customer id');
            return [];
        }
        debug('fetching receipts');
        const receipts = await this.stripe.invoices.list({ customer: stripeCustomerId, status: 'paid', limit: 10 });
        return receipts.data.map(e => {
            return {
                date: util_1.formatUnixDate(e.created),
                currency: e.currency,
                amount: e.total,
                url: e.invoice_pdf,
            };
        });
    }
    /**
     * Validate coupon
     */
    async validateCoupon(couponCode) {
        try {
            const coupon = await this.stripe.coupons.retrieve(couponCode);
            return coupon.valid === true;
        }
        catch (err) {
            return false;
        }
    }
    /**
       * Get setup intent client secret for payment method form.
       */
    async getClientSecret() {
        debug('creating setup intent');
        const si = await this.stripe.setupIntents.create();
        return si.client_secret;
    }
    async parseSubscription(customer) {
        const sub = customer ? customer.subscriptions.data[0] : null;
        const resp = {
            id: null,
            valid: false,
            cancelled: false,
            card: this.parseCard(this.getCard(customer, sub)),
            plan: this.parsePlan(sub),
            customer: this.parseCustomer(customer),
        };
        if (!sub) {
            return resp;
        }
        // Defaults with a valid sub
        resp.id = sub.id;
        resp.valid = true;
        resp.cancelled = false;
        switch (sub.status) {
            case 'trialing': {
                resp.status = `Trialing until ${util_1.formatUnixDate(sub.trial_end)}`;
                return resp;
            }
            case 'active': {
                const periodEnd = util_1.formatUnixDate(sub.current_period_end);
                if (sub.cancel_at_period_end) {
                    resp.cancelled = true;
                    resp.status = `Cancels on ${periodEnd}`;
                }
                else {
                    resp.status = `Renews on ${periodEnd}`;
                }
                return resp;
            }
            case 'incomplete':
            case 'past_due': {
                const invoice = await this.stripe.invoices.retrieve(sub.latest_invoice, {
                    expand: ['payment_intent']
                });
                const paymentIntent = invoice.payment_intent;
                if (paymentIntent.last_payment_error) {
                    resp.status = paymentIntent.last_payment_error.message;
                }
                else {
                    switch (paymentIntent.status) {
                        case 'requires_action': {
                            resp.status = 'Invalid payment method (requires action)';
                            break;
                        }
                        case 'requires_payment_method': {
                            resp.status = 'Invalid payment method';
                            break;
                        }
                        case 'requires_confirmation': {
                            resp.status = 'Waiting for a new attempt';
                            break;
                        }
                    }
                }
                resp.valid = false;
                return resp;
            }
            case 'incomplete_expired':
            case 'canceled':
            case 'unpaid':
                return { valid: false };
            default:
                console.log('unhandled status', sub.status);
                return { valid: false };
        }
    }
    parseCard(card) {
        if (card) {
            const month = String(card.exp_month).padStart(2, '0');
            const year = String(card.exp_year).slice(2);
            const brand = credit_card_brands_1.default[card.brand] || card.brand;
            return {
                brand: card.brand,
                month: card.exp_month,
                year: card.exp_year,
                last4: card.last4,
                summary: `${brand} ending in ${card.last4} (${month}/${year})`
            };
        }
        else {
            return null;
        }
    }
    // Stripe maximum confusion with two different Card types.
    getCard(customer, sub) {
        if (sub && sub.default_payment_method) {
            return sub.default_payment_method.card;
        }
        else if (customer) {
            if (customer.invoice_settings.default_payment_method) {
                return customer.invoice_settings.default_payment_method.card;
            }
            else {
                return customer.sources.data[0];
            }
        }
        else {
            return null;
        }
    }
    parseCustomer(customer) {
        if (customer) {
            return {
                id: customer.id,
                email: customer.email,
                name: customer.name,
                country: customer.address ? customer.address.country : null,
                postcode: customer.address ? customer.address.postal_code : null,
                vat: customer.tax_ids.data.length > 0 ? customer.tax_ids.data[0].value : null,
            };
        }
        return null;
    }
    parsePlan(sub) {
        if (sub && sub.plan) {
            return {
                id: sub.plan.id,
                name: sub.plan.nickname,
                metadata: sub.plan.metadata,
                amount: sub.plan.amount,
                currency: sub.plan.currency,
                interval: sub.plan.interval,
            };
        }
        return null;
    }
}
exports.Checkout = Checkout;
function default_1(stripe) {
    return new Checkout(stripe);
}
exports.default = default_1;
//# sourceMappingURL=index.js.map