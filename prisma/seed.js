require('dotenv').config();
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('--- Seeding FeedForward Database ---');

  const passwordHash = await bcrypt.hash('password123', 10);

  // 1. Restaurant 1: Royal Biryani House
  let restoUser1 = await prisma.user.upsert({
    where: { email: 'royalbiryani@feedforward.org' },
    update: {},
    create: {
      email: 'royalbiryani@feedforward.org',
      phone: '+919876543210',
      password: passwordHash,
      name: 'Chef Rajesh Sharma',
      role: 'RESTAURANT',
      isVerified: true
    }
  });

  const resto1 = await prisma.restaurant.upsert({
    where: { id: 1 },
    update: {
      name: 'Royal Biryani House',
      address: '88, 5th Cross, 60ft Road, Koramangala 5th Block, Bengaluru',
      phone: '+91 80 4122 9011',
      fssaiNumber: '11223344556677',
      latitude: 12.9352,
      longitude: 77.6245,
      cuisineType: 'Mughlai & Biryani',
      approvalStatus: 'APPROVED',
      karmaScore: 100
    },
    create: {
      id: 1,
      name: 'Royal Biryani House',
      address: '88, 5th Cross, 60ft Road, Koramangala 5th Block, Bengaluru',
      phone: '+91 80 4122 9011',
      fssaiNumber: '11223344556677',
      latitude: 12.9352,
      longitude: 77.6245,
      cuisineType: 'Mughlai & Biryani',
      approvalStatus: 'APPROVED',
      karmaScore: 100,
      ownerId: restoUser1.id
    }
  });

  // 2. Restaurant 2: The Rameshwaram Cafe
  let restoUser2 = await prisma.user.upsert({
    where: { email: 'rameshwaram@feedforward.org' },
    update: {},
    create: {
      email: 'rameshwaram@feedforward.org',
      phone: '+919876543211',
      password: passwordHash,
      name: 'Raghavendra Rao',
      role: 'RESTAURANT',
      isVerified: true
    }
  });

  const resto2 = await prisma.restaurant.upsert({
    where: { id: 2 },
    update: {
      name: 'The Rameshwaram Cafe',
      address: '2984, 12th Main Rd, HAL 2nd Stage, Indiranagar, Bengaluru',
      phone: '+91 80 2520 7744',
      fssaiNumber: '11223344556688',
      latitude: 12.9716,
      longitude: 77.6412,
      cuisineType: 'South Indian Pure Veg',
      approvalStatus: 'APPROVED',
      karmaScore: 100
    },
    create: {
      id: 2,
      name: 'The Rameshwaram Cafe',
      address: '2984, 12th Main Rd, HAL 2nd Stage, Indiranagar, Bengaluru',
      phone: '+91 80 2520 7744',
      fssaiNumber: '11223344556688',
      latitude: 12.9716,
      longitude: 77.6412,
      cuisineType: 'South Indian Pure Veg',
      approvalStatus: 'APPROVED',
      karmaScore: 100,
      ownerId: restoUser2.id
    }
  });

  // 3. Restaurant 3: FarmFresh Wholesale & Agro
  let restoUser3 = await prisma.user.upsert({
    where: { email: 'farmfresh@feedforward.org' },
    update: {},
    create: {
      email: 'farmfresh@feedforward.org',
      phone: '+919876543212',
      password: passwordHash,
      name: 'Kisan Agro Collective',
      role: 'RESTAURANT',
      isVerified: true
    }
  });

  const resto3 = await prisma.restaurant.upsert({
    where: { id: 3 },
    update: {
      name: 'FarmFresh Wholesale & Agro',
      address: 'APMC Yard, Yeshwanthpur, Bengaluru',
      phone: '+91 80 2337 1100',
      fssaiNumber: '11223344556699',
      latitude: 13.0285,
      longitude: 77.5458,
      cuisineType: 'Raw Ingredients & Grains',
      approvalStatus: 'APPROVED',
      karmaScore: 100
    },
    create: {
      id: 3,
      name: 'FarmFresh Wholesale & Agro',
      address: 'APMC Yard, Yeshwanthpur, Bengaluru',
      phone: '+91 80 2337 1100',
      fssaiNumber: '11223344556699',
      latitude: 13.0285,
      longitude: 77.5458,
      cuisineType: 'Raw Ingredients & Grains',
      approvalStatus: 'APPROVED',
      karmaScore: 100,
      ownerId: restoUser3.id
    }
  });

  // 4. NGO: Robin Hood Army
  let ngoUser = await prisma.user.upsert({
    where: { email: 'robinhood@feedforward.org' },
    update: {},
    create: {
      email: 'robinhood@feedforward.org',
      phone: '+919876543219',
      password: passwordHash,
      name: 'Robin Hood Army Bengaluru',
      role: 'NGO',
      isVerified: true
    }
  });

  const ngo1 = await prisma.nGO.upsert({
    where: { id: 1 },
    update: {
      name: 'Robin Hood Army — Bengaluru Core',
      tagline: 'Zero-fund volunteer collective serving surplus food to local communities',
      address: 'Koramangala Community Depot, Bengaluru',
      phone: '+91 9876543219',
      darpanId: 'KA/2021/0291884',
      taxExemption: 'Section 80G Certified',
      latitude: 12.9352,
      longitude: 77.6245,
      mission: 'Zero hunger through zero food waste',
      operatingBase: 'Koramangala Community Depot, Bengaluru',
      defaultRadiusKm: 15.0,
      approvalStatus: 'APPROVED',
      karmaScore: 100,
      totalMealsRescued: 3420,
      foodWastePreventedKg: 1710,
      co2eAvoidedTonnes: 4.28
    },
    create: {
      id: 1,
      name: 'Robin Hood Army — Bengaluru Core',
      tagline: 'Zero-fund volunteer collective serving surplus food to local communities',
      address: 'Koramangala Community Depot, Bengaluru',
      phone: '+91 9876543219',
      darpanId: 'KA/2021/0291884',
      taxExemption: 'Section 80G Certified',
      latitude: 12.9352,
      longitude: 77.6245,
      mission: 'Zero hunger through zero food waste',
      operatingBase: 'Koramangala Community Depot, Bengaluru',
      defaultRadiusKm: 15.0,
      approvalStatus: 'APPROVED',
      karmaScore: 100,
      totalMealsRescued: 3420,
      foodWastePreventedKg: 1710,
      co2eAvoidedTonnes: 4.28,
      ownerId: ngoUser.id
    }
  });

  // 5. Seed Real Surplus Listings
  // Clean up existing listings to avoid duplicates during seed
  await prisma.reservation.deleteMany({});
  await prisma.listing.deleteMany({});

  const now = new Date();

  // Listing 1: Cooked Food
  await prisma.listing.create({
    data: {
      id: 1,
      foodName: 'Chicken Dum Biryani & Mirchi Ka Salan',
      category: 'Cooked Food',
      itemType: 'COOKED_MEAL',
      quantityUnit: 'servings',
      pickupWindowStart: now,
      pickupWindowEnd: new Date(now.getTime() + 3 * 3600 * 1000), // 3 hours from now
      totalServings: 50,
      availableServings: 50,
      preparedTime: '8:00 PM',
      safeUntil: new Date(now.getTime() + 3 * 3600 * 1000), // 3 hours from now
      remainingHoursText: '3h left',
      isUrgent: true,
      isVeg: false,
      dietary: ['Halal', 'Contains Dairy'],
      storageInstructions: 'Hot cooked food. Carry insulated thermal crates.',
      imageUrl: 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=800&auto=format&fit=crop&q=80',
      status: 'ACTIVE',
      restaurantId: resto1.id
    }
  });

  // Listing 2: Pure Veg South Indian
  await prisma.listing.create({
    data: {
      id: 2,
      foodName: 'Ghee Podi Idli & Medu Vada with Sambar',
      category: 'Cooked Food',
      itemType: 'COOKED_MEAL',
      quantityUnit: 'servings',
      pickupWindowStart: now,
      pickupWindowEnd: new Date(now.getTime() + 4 * 3600 * 1000), // 4 hours
      totalServings: 60,
      availableServings: 60,
      preparedTime: '7:45 PM',
      safeUntil: new Date(now.getTime() + 4 * 3600 * 1000), // 4 hours
      remainingHoursText: '4h left',
      isUrgent: false,
      isVeg: true,
      dietary: ['Pure Veg', 'Jain Friendly'],
      storageInstructions: 'Keep warm. Bring food-grade stainless containers.',
      imageUrl: 'https://images.unsplash.com/photo-1589301760014-d929f3979dbc?w=800&auto=format&fit=crop&q=80',
      status: 'ACTIVE',
      restaurantId: resto2.id
    }
  });

  // Listing 3: Raw Ingredients (Grains & Pulses)
  await prisma.listing.create({
    data: {
      id: 3,
      foodName: 'Basmati Rice & Toor Dal Sacks (Uncooked)',
      category: 'Raw Ingredients',
      itemType: 'RAW_INGREDIENT',
      quantityUnit: 'kg',
      pickupWindowStart: now,
      pickupWindowEnd: new Date(now.getTime() + 7 * 24 * 3600 * 1000), // 7 days
      totalServings: 80, // 80 kg
      availableServings: 80,
      preparedTime: 'Packed Today',
      safeUntil: new Date(now.getTime() + 7 * 24 * 3600 * 1000), // 7 days
      remainingHoursText: '7 days shelf life',
      isUrgent: false,
      isVeg: true,
      dietary: ['Pure Veg', 'Raw Grain'],
      storageInstructions: 'Dry ambient storage. Keep away from moisture.',
      imageUrl: 'https://images.unsplash.com/photo-1586201375761-83865001e31c?w=800&auto=format&fit=crop&q=80',
      status: 'ACTIVE',
      restaurantId: resto3.id
    }
  });

  // Listing 4: Fresh Bakery & Breads
  await prisma.listing.create({
    data: {
      id: 4,
      foodName: 'Sourdough Boules, Brioche & Baguettes',
      category: 'Bakery',
      itemType: 'BAKERY',
      quantityUnit: 'servings',
      pickupWindowStart: now,
      pickupWindowEnd: new Date(now.getTime() + 18 * 3600 * 1000), // 18 hours
      totalServings: 35,
      availableServings: 35,
      preparedTime: '5:30 PM',
      safeUntil: new Date(now.getTime() + 18 * 3600 * 1000), // 18 hours
      remainingHoursText: 'Tomorrow morning',
      isUrgent: false,
      isVeg: true,
      dietary: ['Pure Veg', 'Contains Gluten'],
      storageInstructions: 'Ambient dry storage. Cardboard crates or paper bags.',
      imageUrl: 'https://images.unsplash.com/photo-1509440159596-0249088772ff?w=800&auto=format&fit=crop&q=80',
      status: 'ACTIVE',
      restaurantId: resto1.id
    }
  });

  // Listing 5: Fresh Produce / Veggies
  await prisma.listing.create({
    data: {
      id: 5,
      foodName: 'Farm Fresh Tomatoes, Carrots & Spinach Crates',
      category: 'Fresh Produce',
      itemType: 'PRODUCE',
      quantityUnit: 'kg',
      pickupWindowStart: now,
      pickupWindowEnd: new Date(now.getTime() + 48 * 3600 * 1000), // 48 hours
      totalServings: 45, // 45 kg
      availableServings: 45,
      preparedTime: 'Harvested Today',
      safeUntil: new Date(now.getTime() + 48 * 3600 * 1000), // 48 hours
      remainingHoursText: '2 days fresh',
      isUrgent: false,
      isVeg: true,
      dietary: ['Pure Veg', 'Fresh Farm Organic'],
      storageInstructions: 'Cool ambient or ventilated crates.',
      imageUrl: 'https://images.unsplash.com/photo-1610348725531-843dff563e2c?w=800&auto=format&fit=crop&q=80',
      status: 'ACTIVE',
      restaurantId: resto3.id
    }
  });

  console.log('Seeding completed successfully!');
}

main()
  .catch((e) => {
    console.error('Error during seeding:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });