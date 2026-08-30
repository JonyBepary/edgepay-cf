/**
 * Generated gateway adapters — GENERATED FILE (scripts/port-gateways/generate.py).
 * One lazy factory per ported provider. Do not edit; regenerate.
 */

import { gatewayRegistry } from '../base';
import { Gw2checkoutGateway } from './2checkout.gateway';
import { AdyenGateway } from './adyen.gateway';
import { AffirmGateway } from './affirm.gateway';
import { AfterpayGateway } from './afterpay.gateway';
import { AmazonPayGateway } from './amazon-pay.gateway';
import { AuthorizeNetGateway } from './authorize-net.gateway';
import { BancontactGateway } from './bancontact.gateway';
import { BillerGenieGateway } from './biller-genie.gateway';
import { BitpayGateway } from './bitpay.gateway';
import { BluesnapGateway } from './bluesnap.gateway';
import { BtcpayGateway } from './btcpay.gateway';
import { CellfinGateway } from './cellfin.gateway';
import { ChasePaymentechGateway } from './chase-paymentech.gateway';
import { CoinbaseCommerceGateway } from './coinbase-commerce.gateway';
import { CybersourceGateway } from './cybersource.gateway';
import { DanaGateway } from './dana.gateway';
import { DlocalGateway } from './dlocal.gateway';
import { EasypaisaGateway } from './easypaisa.gateway';
import { EbanxGateway } from './ebanx.gateway';
import { ElavonGateway } from './elavon.gateway';
import { FastspringGateway } from './fastspring.gateway';
import { FattmerchantGateway } from './fattmerchant.gateway';
import { FirstDataGateway } from './first-data.gateway';
import { FiservGateway } from './fiserv.gateway';
import { FlutterwaveGateway } from './flutterwave.gateway';
import { GcashGateway } from './gcash.gateway';
import { GlobalPaymentsGateway } from './global-payments.gateway';
import { GocardlessGateway } from './gocardless.gateway';
import { GrabpayGateway } from './grabpay.gateway';
import { HeartlandGateway } from './heartland.gateway';
import { HelcimGateway } from './helcim.gateway';
import { IdealGateway } from './ideal.gateway';
import { KakaopayGateway } from './kakaopay.gateway';
import { MayaGateway } from './maya.gateway';
import { MercadolibreWalletGateway } from './mercadolibre-wallet.gateway';
import { MercadopagoGateway } from './mercadopago.gateway';
import { MidtransGateway } from './midtrans.gateway';
import { MobikwikGateway } from './mobikwik.gateway';
import { MollieGateway } from './mollie.gateway';
import { MomoGateway } from './momo.gateway';
import { MonerisGateway } from './moneris.gateway';
import { MpesaGateway } from './mpesa.gateway';
import { NetellerGateway } from './neteller.gateway';
import { NexuspayGateway } from './nexuspay.gateway';
import { NmiGateway } from './nmi.gateway';
import { OkWalletGateway } from './ok-wallet.gateway';
import { OpayGateway } from './opay.gateway';
import { OpennodeGateway } from './opennode.gateway';
import { OvoGateway } from './ovo.gateway';
import { PaylineDataGateway } from './payline-data.gateway';
import { PaymeGateway } from './payme.gateway';
import { PaymentDepotGateway } from './payment-depot.gateway';
import { PayoneerGateway } from './payoneer.gateway';
import { PaystackGateway } from './paystack.gateway';
import { PaytraceGateway } from './paytrace.gateway';
import { PayuGateway } from './payu.gateway';
import { PhonepeGateway } from './phonepe.gateway';
import { PromptpayGateway } from './promptpay.gateway';
import { RapydGateway } from './rapyd.gateway';
import { SezzleGateway } from './sezzle.gateway';
import { Shift4Gateway } from './shift4.gateway';
import { ShopeepayGateway } from './shopeepay.gateway';
import { SkrillGateway } from './skrill.gateway';
import { SquareGateway } from './square.gateway';
import { StaxGateway } from './stax.gateway';
import { TapGateway } from './tap.gateway';
import { TouchNGoGateway } from './touch-n-go.gateway';
import { TruemoneyGateway } from './truemoney.gateway';
import { TrustcommerceGateway } from './trustcommerce.gateway';
import { TsysGateway } from './tsys.gateway';
import { UpayGateway } from './upay.gateway';
import { WechatPayGateway } from './wechat-pay.gateway';
import { WiseGateway } from './wise.gateway';
import { WorldlineGateway } from './worldline.gateway';
import { WorldpayGateway } from './worldpay.gateway';
import { XenditGateway } from './xendit.gateway';

/** Registry slugs of every adapter produced by the port pipeline. */
export const GENERATED_GATEWAY_SLUGS = [
  '2checkout',
  'adyen',
  'affirm',
  'afterpay',
  'amazon-pay',
  'authorize-net',
  'bancontact',
  'biller-genie',
  'bitpay',
  'bluesnap',
  'btcpay',
  'cellfin',
  'chase-paymentech',
  'coinbase-commerce',
  'cybersource',
  'dana',
  'dlocal',
  'easypaisa',
  'ebanx',
  'elavon',
  'fastspring',
  'fattmerchant',
  'first-data',
  'fiserv',
  'flutterwave',
  'gcash',
  'global-payments',
  'gocardless',
  'grabpay',
  'heartland',
  'helcim',
  'ideal',
  'kakaopay',
  'maya',
  'mercadolibre-wallet',
  'mercadopago',
  'midtrans',
  'mobikwik',
  'mollie',
  'momo',
  'moneris',
  'mpesa',
  'neteller',
  'nexuspay',
  'nmi',
  'ok-wallet',
  'opay',
  'opennode',
  'ovo',
  'payline-data',
  'payme',
  'payment-depot',
  'payoneer',
  'paystack',
  'paytrace',
  'payu',
  'phonepe',
  'promptpay',
  'rapyd',
  'sezzle',
  'shift4',
  'shopeepay',
  'skrill',
  'square',
  'stax',
  'tap',
  'touch-n-go',
  'truemoney',
  'trustcommerce',
  'tsys',
  'upay',
  'wechat-pay',
  'wise',
  'worldline',
  'worldpay',
  'xendit',
] as const;

gatewayRegistry.register('2checkout', () => new Gw2checkoutGateway());
gatewayRegistry.register('adyen', () => new AdyenGateway());
gatewayRegistry.register('affirm', () => new AffirmGateway());
gatewayRegistry.register('afterpay', () => new AfterpayGateway());
gatewayRegistry.register('amazon-pay', () => new AmazonPayGateway());
gatewayRegistry.register('authorize-net', () => new AuthorizeNetGateway());
gatewayRegistry.register('bancontact', () => new BancontactGateway());
gatewayRegistry.register('biller-genie', () => new BillerGenieGateway());
gatewayRegistry.register('bitpay', () => new BitpayGateway());
gatewayRegistry.register('bluesnap', () => new BluesnapGateway());
gatewayRegistry.register('btcpay', () => new BtcpayGateway());
gatewayRegistry.register('cellfin', () => new CellfinGateway());
gatewayRegistry.register('chase-paymentech', () => new ChasePaymentechGateway());
gatewayRegistry.register('coinbase-commerce', () => new CoinbaseCommerceGateway());
gatewayRegistry.register('cybersource', () => new CybersourceGateway());
gatewayRegistry.register('dana', () => new DanaGateway());
gatewayRegistry.register('dlocal', () => new DlocalGateway());
gatewayRegistry.register('easypaisa', () => new EasypaisaGateway());
gatewayRegistry.register('ebanx', () => new EbanxGateway());
gatewayRegistry.register('elavon', () => new ElavonGateway());
gatewayRegistry.register('fastspring', () => new FastspringGateway());
gatewayRegistry.register('fattmerchant', () => new FattmerchantGateway());
gatewayRegistry.register('first-data', () => new FirstDataGateway());
gatewayRegistry.register('fiserv', () => new FiservGateway());
gatewayRegistry.register('flutterwave', () => new FlutterwaveGateway());
gatewayRegistry.register('gcash', () => new GcashGateway());
gatewayRegistry.register('global-payments', () => new GlobalPaymentsGateway());
gatewayRegistry.register('gocardless', () => new GocardlessGateway());
gatewayRegistry.register('grabpay', () => new GrabpayGateway());
gatewayRegistry.register('heartland', () => new HeartlandGateway());
gatewayRegistry.register('helcim', () => new HelcimGateway());
gatewayRegistry.register('ideal', () => new IdealGateway());
gatewayRegistry.register('kakaopay', () => new KakaopayGateway());
gatewayRegistry.register('maya', () => new MayaGateway());
gatewayRegistry.register('mercadolibre-wallet', () => new MercadolibreWalletGateway());
gatewayRegistry.register('mercadopago', () => new MercadopagoGateway());
gatewayRegistry.register('midtrans', () => new MidtransGateway());
gatewayRegistry.register('mobikwik', () => new MobikwikGateway());
gatewayRegistry.register('mollie', () => new MollieGateway());
gatewayRegistry.register('momo', () => new MomoGateway());
gatewayRegistry.register('moneris', () => new MonerisGateway());
gatewayRegistry.register('mpesa', () => new MpesaGateway());
gatewayRegistry.register('neteller', () => new NetellerGateway());
gatewayRegistry.register('nexuspay', () => new NexuspayGateway());
gatewayRegistry.register('nmi', () => new NmiGateway());
gatewayRegistry.register('ok-wallet', () => new OkWalletGateway());
gatewayRegistry.register('opay', () => new OpayGateway());
gatewayRegistry.register('opennode', () => new OpennodeGateway());
gatewayRegistry.register('ovo', () => new OvoGateway());
gatewayRegistry.register('payline-data', () => new PaylineDataGateway());
gatewayRegistry.register('payme', () => new PaymeGateway());
gatewayRegistry.register('payment-depot', () => new PaymentDepotGateway());
gatewayRegistry.register('payoneer', () => new PayoneerGateway());
gatewayRegistry.register('paystack', () => new PaystackGateway());
gatewayRegistry.register('paytrace', () => new PaytraceGateway());
gatewayRegistry.register('payu', () => new PayuGateway());
gatewayRegistry.register('phonepe', () => new PhonepeGateway());
gatewayRegistry.register('promptpay', () => new PromptpayGateway());
gatewayRegistry.register('rapyd', () => new RapydGateway());
gatewayRegistry.register('sezzle', () => new SezzleGateway());
gatewayRegistry.register('shift4', () => new Shift4Gateway());
gatewayRegistry.register('shopeepay', () => new ShopeepayGateway());
gatewayRegistry.register('skrill', () => new SkrillGateway());
gatewayRegistry.register('square', () => new SquareGateway());
gatewayRegistry.register('stax', () => new StaxGateway());
gatewayRegistry.register('tap', () => new TapGateway());
gatewayRegistry.register('touch-n-go', () => new TouchNGoGateway());
gatewayRegistry.register('truemoney', () => new TruemoneyGateway());
gatewayRegistry.register('trustcommerce', () => new TrustcommerceGateway());
gatewayRegistry.register('tsys', () => new TsysGateway());
gatewayRegistry.register('upay', () => new UpayGateway());
gatewayRegistry.register('wechat-pay', () => new WechatPayGateway());
gatewayRegistry.register('wise', () => new WiseGateway());
gatewayRegistry.register('worldline', () => new WorldlineGateway());
gatewayRegistry.register('worldpay', () => new WorldpayGateway());
gatewayRegistry.register('xendit', () => new XenditGateway());
