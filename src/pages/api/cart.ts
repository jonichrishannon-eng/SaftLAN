import type { APIRoute } from 'astro';

// We'll keep a very simple server-side state for the session just for the demo effect
// In a real app, you'd use a cookie-based session or database
let currentTotal = 0;

export const POST: APIRoute = async ({ request }) => {
  try {
    const data = await request.json();
    const priceStr = data.price.replace(',', '.'); // Handle German comma decimals
    const price = parseFloat(priceStr);

    if (!isNaN(price)) {
      currentTotal += price;
    }

    // Format back to string
    const newTotalStr = currentTotal.toFixed(2) + ' €';

    // Return HTML fragment targeted at the cart total using Datastar conventions
    // Datastar defaults to morphing the target element with the new HTML
    return new Response(
      `<div id="cart-total" class="text-2xl text-cyan-400 font-black scale-125 transition-transform duration-300 ease-out" onload="setTimeout(() => this.classList.remove('scale-125', 'text-cyan-400'), 300)">${newTotalStr}</div>`,
      { headers: { 'Content-Type': 'text/html' } }
    );
  } catch (err) {
    return new Response('Error adding to cart', { status: 500 });
  }
};