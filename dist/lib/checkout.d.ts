import Stripe from 'stripe';
import { Receipt, Subscription, ManageSubscriptionOptions } from './types';
export default class Checkout {
    private stripe;
    constructor(stripe: Stripe);
    getSubscription(stripeCustomerId: string): Promise<Subscription>;
    validateVatNumber(q: string): Promise<boolean>;
    manageSubscription(stripeCustomerId: string, opts?: ManageSubscriptionOptions): Promise<string>;
    /**
     * Cancel a subscription (default at period end).
     */
    cancelSubscription(stripeCustomerId: string, atPeriodEnd?: boolean): Promise<void>;
    /**
     * Reactivate a subscription that has been cancelled (if at period end).
     */
    reactivateSubscription(stripeCustomerId: string): Promise<boolean>;
    /**
     * Delete a subscription immediately (e.g. when closing an account).
     */
    deleteSubscription(stripeCustomerId: string): Promise<boolean>;
    /**
     * Delete a subscription immediately (e.g. when closing an account).
     */
    deleteCustomer(stripeCustomerId: string): Promise<boolean>;
    /**
     * List all receipts
     */
    getReceipts(stripeCustomerId: string): Promise<Receipt[]>;
    /**
     * Validate coupon
     */
    validateCoupon(couponCode: string): Promise<boolean>;
    /**
       * Get setup intent client secret for payment method form.
       */
    getClientSecret(): Promise<string>;
    private parseSubscription;
    private parseCard;
    private getCard;
    private parseCustomer;
    private parsePlan;
}
