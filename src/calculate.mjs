export const isNumber = value => typeof value === 'number' && Number.isFinite(value);
export function kilo(offer) {
  if (!(offer.units > 0 && offer.unit_kg > 0 && offer.price_eur > 0)) return null;
  return offer.price_eur / (offer.units * offer.unit_kg);
}
export function orderShipping(offer, subtotal, kg) {
  if (!isNumber(subtotal) || subtotal <= 0) return null;
  if (isNumber(offer.min_order_eur) && subtotal < offer.min_order_eur) return null;
  if (isNumber(offer.shipping_weight_limit_kg)) {
    if (!isNumber(kg)) return subtotal === offer.price_eur && isNumber(offer.shipping_single_quote_eur) ? offer.shipping_single_quote_eur : null;
    if (kg > offer.shipping_weight_limit_kg) return isNumber(offer.shipping_overweight_eur) ? offer.shipping_overweight_eur : null;
  }
  if (Array.isArray(offer.shipping_tiers)) {
    const match = offer.shipping_tiers.findLast(tier => subtotal >= tier.from_eur);
    return match && isNumber(match.shipping_eur) ? match.shipping_eur : null;
  }
  const quoted = isNumber(offer.shipping_eur) && offer.shipping_eur >= 0;
  if (quoted && subtotal === offer.price_eur) return offer.shipping_eur;
  if (isNumber(offer.free_from_eur) && subtotal >= offer.free_from_eur) return 0;
  return quoted ? offer.shipping_eur : null;
}
export function delivered(offer) {
  const kg = offer.shipping_weight_kg ?? (offer.unit_kg > 0 && offer.units > 0 ? offer.units * offer.unit_kg : null);
  const shipping = orderShipping(offer, offer.price_eur, kg);
  return shipping === null ? null : Math.round((offer.price_eur + shipping) * 100) / 100;
}
export function deliveredKilo(offer) {
  const total = delivered(offer);
  return total !== null && kilo(offer) !== null ? total / (offer.units * offer.unit_kg) : null;
}
export function referenceCost(offer, grams) {
  const unit = deliveredKilo(offer);
  return unit !== null && grams > 0 ? unit * grams / 1000 : null;
}
export function analytical(food) {
  const a = food.analysis;
  const estimated = a.moisture === null && food.form === 'droog' && !food.analysis_bounds?.moisture;
  const moisture = estimated ? 9 : a.moisture;
  const dry = isNumber(moisture) && moisture >= 0 && moisture < 100 ? 100 - moisture : null;
  const parts = [a.protein, a.fat, a.fibre, a.ash, moisture];
  const sum = parts.every(v => isNumber(v) && v >= 0 && v <= 100) ? parts.reduce((n,v)=>n+v,0) : null;
  const valid = sum === null || sum <= 100.0000001;
  const nfe = sum !== null && valid && dry !== null ? Math.max(0, 100 - sum) : null;
  const asDry = value => valid && dry !== null && isNumber(value) && value >= 0 && value <= dry ? value / dry * 100 : null;
  return {estimated, moisture, dry, nfe, nfeDry:asDry(nfe), proteinDry:asDry(a.protein), fatDry:asDry(a.fat)};
}
export function tco(product, offer) {
  const amounts = [delivered(offer),product.subscription_monthly_eur,product.annual_consumables_eur];
  return amounts.every(v=>isNumber(v)&&v>=0) ? amounts[0]+24*amounts[1]+2*amounts[2] : null;
}
export function orderedOffers(product) {
  return [...product.offers].sort((a,b)=>{
    const stock = o => ({in_stock:0,unknown:1,out_of_stock:2})[o.stock] ?? 2;
    const rate = o => product.species ? deliveredKilo(o) : delivered(o);
    const fallback = o => product.species ? kilo(o) : o.price_eur;
    return stock(a)-stock(b) || (rate(a) ?? Infinity)-(rate(b) ?? Infinity) || fallback(a)-fallback(b) || a.shop.localeCompare(b.shop,'nl');
  });
}
export function offerFloor(p) {
  const prices = p.offers.filter(o=>o.stock==='in_stock' && o.price_eur > 0).map(o=>o.price_eur);
  return prices.length ? Math.min(...prices) : null;
}

