'use strict';

/* ======================================================================
   Kerala food database + pantry ingredients
   Values are per typical home serving and approximate.
   ====================================================================== */

const INGREDIENT_GROUPS = [
  {
    name: 'GRAINS & STAPLES',
    items: ['rice', 'puttu podi', 'atta', 'appam batter', 'idli batter', 'dosa batter', 'semolina', 'oats', 'tapioca', 'bread']
  },
  {
    name: 'PROTEIN',
    items: ['eggs', 'chicken', 'fish', 'sardines', 'prawns', 'beef', 'paneer', 'soya chunks', 'dal', 'chana', 'green gram', 'curd', 'milk']
  },
  {
    name: 'VEGETABLES & AROMATICS',
    items: ['onion', 'tomato', 'ginger', 'garlic', 'green chilli', 'curry leaves', 'mustard seeds', 'coconut', 'cabbage', 'beans', 'carrot', 'drumstick', 'raw banana', 'spinach', 'cucumber', 'lemon', 'potato']
  },
  {
    name: 'FRUITS & NUTS',
    items: ['banana', 'papaya', 'apple', 'peanuts', 'cashews', 'coconut water']
  },
  {
    name: 'OILS & SPICES',
    items: ['coconut oil', 'turmeric', 'chilli powder', 'coriander powder', 'garam masala', 'black pepper', 'salt', 'tamarind', 'fenugreek']
  }
];

const DEFAULT_PANTRY = [
  'rice', 'puttu podi', 'eggs', 'milk', 'curd', 'coconut',
  'onion', 'tomato', 'ginger', 'garlic', 'green chilli', 'curry leaves',
  'mustard seeds', 'coconut oil', 'dal', 'banana', 'peanuts', 'coconut water'
];

const FOOD_DB = [
  /* ----- breakfast ----- */
  {
    id: 'puttu-kadala', name: 'Puttu + Kadala Curry', meals: ['breakfast'],
    kcal: 430, protein: 17,
    ingredients: ['puttu podi', 'chana', 'onion', 'tomato', 'coconut', 'curry leaves', 'mustard seeds', 'coconut oil']
  },
  {
    id: 'appam-egg', name: 'Appam + Egg Roast', meals: ['breakfast', 'dinner'],
    kcal: 390, protein: 18,
    ingredients: ['appam batter', 'eggs', 'onion', 'tomato', 'ginger', 'curry leaves', 'coconut oil']
  },
  {
    id: 'idli-sambar', name: 'Idli + Sambar', meals: ['breakfast'],
    kcal: 330, protein: 13,
    ingredients: ['idli batter', 'dal', 'drumstick', 'onion', 'tomato', 'tamarind', 'curry leaves']
  },
  {
    id: 'masala-dosa', name: 'Masala Dosa', meals: ['breakfast'],
    kcal: 380, protein: 9,
    ingredients: ['dosa batter', 'potato', 'onion', 'mustard seeds', 'curry leaves', 'coconut oil']
  },
  {
    id: 'oats-banana', name: 'Oats with Banana & Milk', meals: ['breakfast', 'snack'],
    kcal: 340, protein: 16,
    ingredients: ['oats', 'milk', 'banana', 'peanuts']
  },
  {
    id: 'upma', name: 'Vegetable Upma', meals: ['breakfast'],
    kcal: 310, protein: 9,
    ingredients: ['semolina', 'carrot', 'beans', 'onion', 'mustard seeds', 'coconut oil']
  },
  {
    id: 'kanji-payar', name: 'Kanji + Cherupayar', meals: ['breakfast', 'dinner'],
    kcal: 350, protein: 15,
    ingredients: ['rice', 'green gram', 'coconut', 'curry leaves']
  },

  /* ----- lunch / dinner ----- */
  {
    id: 'rice-fish', name: 'Rice + Mathi Curry', meals: ['lunch', 'dinner'],
    kcal: 520, protein: 30,
    ingredients: ['rice', 'sardines', 'coconut', 'onion', 'tomato', 'chilli powder', 'curry leaves', 'tamarind']
  },
  {
    id: 'rice-parippu', name: 'Rice + Parippu + Thoran', meals: ['lunch', 'dinner'],
    kcal: 470, protein: 18,
    ingredients: ['rice', 'dal', 'coconut', 'cabbage', 'mustard seeds', 'curry leaves']
  },
  {
    id: 'chicken-stew', name: 'Chicken Stew + Appam', meals: ['dinner', 'breakfast'],
    kcal: 460, protein: 32,
    ingredients: ['chicken', 'appam batter', 'coconut', 'onion', 'ginger', 'green chilli', 'curry leaves']
  },
  {
    id: 'meen-pollichathu', name: 'Meen Pollichathu', meals: ['lunch', 'dinner'],
    kcal: 380, protein: 34,
    ingredients: ['fish', 'onion', 'tomato', 'curry leaves', 'coconut oil', 'chilli powder', 'lemon']
  },
  {
    id: 'chicken-curry', name: 'Kerala Chicken Curry + Rice', meals: ['lunch', 'dinner'],
    kcal: 540, protein: 34,
    ingredients: ['chicken', 'rice', 'onion', 'tomato', 'ginger', 'garlic', 'coconut oil', 'chilli powder', 'garam masala']
  },
  {
    id: 'avial', name: 'Avial + Rice', meals: ['lunch'],
    kcal: 400, protein: 11,
    ingredients: ['rice', 'coconut', 'carrot', 'beans', 'drumstick', 'raw banana', 'curd', 'curry leaves']
  },
  {
    id: 'kappa-meen', name: 'Kappa + Meen Curry', meals: ['lunch', 'dinner'],
    kcal: 500, protein: 28,
    ingredients: ['tapioca', 'sardines', 'coconut', 'onion', 'curry leaves', 'chilli powder']
  },
  {
    id: 'egg-curry', name: 'Egg Curry + Rice', meals: ['lunch', 'dinner'],
    kcal: 470, protein: 22,
    ingredients: ['eggs', 'rice', 'onion', 'tomato', 'coconut', 'chilli powder', 'curry leaves']
  },
  {
    id: 'prawn-curry', name: 'Prawn Curry + Rice', meals: ['lunch', 'dinner'],
    kcal: 500, protein: 32,
    ingredients: ['prawns', 'rice', 'coconut', 'onion', 'tomato', 'curry leaves']
  },
  {
    id: 'moru-rice', name: 'Moru Curry + Rice', meals: ['lunch'],
    kcal: 380, protein: 12,
    ingredients: ['rice', 'curd', 'coconut', 'ginger', 'green chilli', 'curry leaves']
  },
  {
    id: 'grilled-fish', name: 'Grilled Fish + Salad', meals: ['dinner', 'lunch'],
    kcal: 320, protein: 38,
    ingredients: ['fish', 'cucumber', 'tomato', 'onion', 'lemon', 'black pepper']
  },
  {
    id: 'chicken-chapati', name: 'Chicken Stir-fry + Chapati', meals: ['dinner', 'lunch'],
    kcal: 470, protein: 36,
    ingredients: ['chicken', 'atta', 'onion', 'beans', 'carrot', 'coconut oil']
  },
  {
    id: 'soya-rice', name: 'Soya Chunks Curry + Rice', meals: ['lunch', 'dinner'],
    kcal: 430, protein: 28,
    ingredients: ['soya chunks', 'rice', 'onion', 'tomato', 'coconut oil', 'chilli powder']
  },
  {
    id: 'paneer-chapati', name: 'Paneer Bhurji + Chapati', meals: ['dinner', 'lunch'],
    kcal: 450, protein: 26,
    ingredients: ['paneer', 'atta', 'onion', 'tomato', 'turmeric']
  },
  {
    id: 'beef-chapati', name: 'Beef Fry + Chapati', meals: ['dinner', 'lunch'],
    kcal: 580, protein: 40,
    ingredients: ['beef', 'atta', 'coconut', 'onion', 'black pepper', 'coconut oil']
  },
  {
    id: 'sardine-kanji', name: 'Sardine Fry + Kanji', meals: ['dinner'],
    kcal: 450, protein: 30,
    ingredients: ['sardines', 'rice', 'coconut oil', 'chilli powder', 'curry leaves']
  },
  {
    id: 'beans-thoran', name: 'Beans Thoran + Dal + Rice', meals: ['lunch', 'dinner'],
    kcal: 420, protein: 16,
    ingredients: ['beans', 'coconut', 'dal', 'rice', 'mustard seeds', 'curry leaves']
  },

  /* ----- snacks / quick ----- */
  {
    id: 'banana-shake', name: 'Banana Peanut Shake', meals: ['snack', 'breakfast'],
    kcal: 330, protein: 13,
    ingredients: ['banana', 'milk', 'peanuts']
  },
  {
    id: 'boiled-eggs', name: '3 Boiled Eggs', meals: ['snack', 'breakfast'],
    kcal: 240, protein: 21,
    ingredients: ['eggs']
  },
  {
    id: 'curd-bowl', name: 'Curd Bowl', meals: ['snack'],
    kcal: 120, protein: 7,
    ingredients: ['curd']
  },
  {
    id: 'tender-coconut', name: 'Tender Coconut Water', meals: ['snack'],
    kcal: 60, protein: 1,
    ingredients: ['coconut water']
  }
];

const QUICK_FOODS = [
  { name: 'Banana', kcal: 105, protein: 1 },
  { name: '3 Boiled Eggs', kcal: 240, protein: 21 },
  { name: 'Curd Bowl', kcal: 120, protein: 7 },
  { name: 'Peanuts (handful)', kcal: 170, protein: 7 },
  { name: 'Milk (glass)', kcal: 150, protein: 8 },
  { name: 'Tender Coconut', kcal: 60, protein: 1 },
  { name: 'Oats + Milk', kcal: 250, protein: 11 },
  { name: 'Chicken Breast (100g)', kcal: 165, protein: 31 }
];
