# TO Assistant — Full Magento Category ID Reference

**Source of truth:** `server.js` lines 83–191 (`CATEGORY_TO_SPORT`).
**Purpose:** Authoritative contract for the v6.4.0 **Resolver** stage.
The Resolver MUST choose a `category_id` that appears in this file.
It MUST pick the sport-specific root, not a sibling sport's root.

Every ID listed below is also in `CATEGORY_TO_SPORT` in `server.js`. If a new
ID is added to Magento, both this file and the in-code map must be updated
together — they are a single contract split across two files.

---

## Quick-lookup: the 12 product-type roots (sport × type)

These are the IDs the Resolver will pass to `get_products_by_category()`
99% of the time. Everything else in this file is sub-category detail.

| Product type | Tennis | Pickleball | Padel |
|---|---|---|---|
| Racquets / Paddles | **25** | **250** | **272** |
| Balls | **31** | **252** | **273** |
| Shoes | **24** | **253** | **274** |
| Bags | **115** | **254** | **275** |

> Regression that v6.4.0 fixes: the v6.3.5 Specialist was passing `115`
> (tennis bags) for "pickle bag". Correct pickleball bags root is `254`.
> Correct padel bags root is `275`.

---

## Cross-store / shared roots (tennis outlet, but usable across contexts)

| Purpose | ID | Notes |
|---|---|---|
| Strings | 29 | Tennis-only category but relevant for any string query |
| Accessories (tennis) | 37 | Grips, dampeners, overgrips, etc. |
| Used Racquets | 90 | Pre-owned tennis racquets |
| Clothing (tennis) | 36 | Apparel |
| Stringing service | 38 | In-store stringing |
| Wimbledon Sale | 292 | Seasonal |
| Grand Slam Collection | 349 | Seasonal |
| Boxing Day Sale | 437 | Seasonal |

Accessory roots per sport:
- **Tennis**: 37
- **Pickleball**: 256
- **Padel**: 276

---

## Padel Outlet (padeloutlet.in)

**Store root:** `245`

### Rackets — root `272`
Brand/line subcategories:
`272, 277, 278, 279, 280, 303, 329, 331, 339, 427`

### Balls — root `273`
Brand subcategories:
`273, 281, 282, 283, 284, 313, 360, 428, 453`

### Shoes — root `274`
Brand subcategories:
`274, 287, 288, 289, 290, 291, 314, 367, 424`

### Bags — root `275`
Brand subcategories:
`275, 304, 305, 306, 318, 330, 369`

### Accessories, Sale, Collections, Best Sellers — root `276`
`276, 363, 375, 432, 436, 452`

---

## Pickleball Outlet (pickleballoutlet.in)

**Store root:** `243`

### Paddles — root `250`
Brand / line subcategories (Selkirk, Joola, Paddletek, Onix, Engage,
Franklin, Vatic Pro, CRBN, Six Zero, Diadem, etc.):
`250, 257, 258, 259, 260, 261, 262, 302, 307, 332, 333, 345, 351, 354,
355, 356, 357, 394, 400, 407, 426, 438, 439, 441, 445, 447`

### Balls — root `252`
Brand subcategories:
`252, 263, 264, 265, 266, 311, 312, 350, 388, 403, 440, 448`

### Shoes — root `253`
Brand subcategories:
`253, 267, 268, 269, 270, 271, 365, 404`

### Bags — root `254`  ← **pickleball bags live here, NOT 115**
Brand subcategories:
`254, 308, 309, 310, 334, 340, 352, 405`

### Net & Post, Accessories, Promotional, Sale, Bloom, Best Sellers
`255` (net & post), `256` (accessories root), `328, 353, 389, 393, 399,
406, 429, 431, 435, 446, 455`

### Syxx — pickleball brand with its own root `401`
`401, 402, 408, 409, 410, 411, 412, 413, 414, 415, 416, 417, 418, 419,
420, 421, 433`

---

## Tennis Outlet (tennisoutlet.in)

### Racquets — root `25`
(The largest block. Covers every brand, skill level, head size, and pro
line.)
`25, 26, 34, 35, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57,
58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 69, 70, 71, 72, 73, 74, 75, 76,
77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 166, 173, 178,
179, 180, 181, 210, 211, 212, 213, 214, 239, 248, 319, 324, 325, 326,
327, 336, 337, 346, 347, 348, 358, 359, 364, 370, 376, 422, 423`
(Note: `90` = Used Racquets, same block.)

### Strings — root `29`
Brand / type subcategories (Luxilon, Babolat VS, Wilson NXT, Head Hawk,
Solinco, Yonex, Tecnifibre, natural gut, poly, hybrid, etc.):
`29, 30, 33, 122, 123, 124, 125, 126, 127, 177, 182, 185, 186, 187, 188,
189, 190, 191, 192, 193, 194, 195, 196, 223, 224, 233, 235, 236, 321,
341, 342, 343, 344, 371, 372, 373, 374`

### Shoes — root `24`
Brand subcategories:
`24, 28, 103, 104, 105, 106, 107, 237, 322`

### Balls — root `31`
Brand subcategories (Wilson, Penn, Dunlop Fort, Slazenger, Head, etc.):
`31, 32, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 361`

### Bags — root `115`
Brand subcategories:
`115, 116, 117, 118, 119, 120, 121`

### Clothing — root `36`
Men / women / junior / accessories:
`36, 108, 109, 110, 111, 112, 113, 114, 368`

### Accessories — root `37`
Grips, dampeners, overgrips, wristbands, etc.:
`37, 128, 129, 130, 131, 132, 133, 134, 135, 136, 183, 390`

### Other — root `137`
`137, 184, 138, 139, 140, 450`

### Stringing service — root `38`
`38, 39, 40, 41, 42, 43, 197, 198, 199, 200, 201, 202, 203, 204, 205,
206, 207, 209, 315, 316, 320, 442, 443, 444`

### Pro Store, Brands, Clearance, Sales, Best Sellers, Promotions
`164, 165, 240, 241, 242, 249, 292, 293, 294, 295, 296, 297, 298, 299,
335, 338, 349, 362, 377, 378, 379, 380, 381, 382, 383, 384, 386, 387,
391, 392, 395, 396, 397, 398, 425, 430, 434, 437, 449, 451, 454`

---

## Resolver decision table (the only lookup logic the Resolver needs)

```js
// Pseudocode — v6.4.0 Resolver
function resolveCategoryId({ sport, productType }) {
  const table = {
    tennis:     { racquet: 25,  ball: 31,  shoe: 24,  bag: 115, string: 29,  accessory: 37  },
    pickleball: { paddle:  250, ball: 252, shoe: 253, bag: 254, accessory: 256 },
    padel:      { racquet: 272, ball: 273, shoe: 274, bag: 275, accessory: 276 },
  };
  return table[sport]?.[productType] ?? null;
}
```

If `resolveCategoryId` returns `null`, the Resolver MUST:
1. Trigger a Clarification Gate response (ask which product type) rather than
   guess a default. Guessing is how v6.3.5 sent "pickleball" to category 25.
2. Never pass the query to the Fetcher without a concrete, sport-matching ID.

---

## What the Resolver is allowed to do with sub-category IDs

- **Brand filters** (e.g., user says "Selkirk paddles"): the Resolver passes
  the sport-specific root (`250`) to the Fetcher and applies the brand filter
  by name — it does NOT switch to the brand's sub-category ID.
  Rationale: brand sub-categories are a superset of products that may be
  discontinued or out of stock; filtering by name on the root gives us the
  live, in-stock set.
- **Sales / collections** (e.g., "Wimbledon Sale"): only when the user
  explicitly asks, pass `292`, `349`, `437`, etc. Never substitute these for
  a product-type query.
- **Stringing service (38)**: only when the user asks for a service booking.

---

## Anti-regression checklist (wire these into the Resolver unit tests)

1. `resolve("pickleball", "paddle")   === 250`  — NOT 25
2. `resolve("pickleball", "bag")      === 254`  — NOT 115
3. `resolve("padel", "racquet")       === 272`  — NOT 25
4. `resolve("padel", "bag")           === 275`  — NOT 115
5. `resolve("tennis",  "bag")         === 115`
6. `resolve("pickleball", undefined)  === null` — triggers Clarification
7. `resolve(undefined, "racquet")     === null` — triggers Clarification

Any resolver change that makes one of these return a different ID is a
breaking regression — ship it only with an intentional test update.
