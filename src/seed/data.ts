/* Demo data for FitBook. Names, gyms and clubs are fictional; park and beach coordinates are approximate. */

export const DEMO_PASSWORD = 'Password123!';

const CHICAGO = {city: 'Chicago', state: 'IL', country: 'US', timezone: 'America/Chicago'} as const;
const NEW_YORK = {
  city: 'New York',
  state: 'NY',
  country: 'US',
  timezone: 'America/New_York',
} as const;
const MIAMI = {city: 'Miami', state: 'FL', country: 'US', timezone: 'America/New_York'} as const;

export type SeedLocation = {
  name: string;
  address: string;
  city: string;
  state: string;
  lat: number;
  lng: number;
  comment?: string;
};

const chicago = (
  name: string,
  address: string,
  lat: number,
  lng: number,
  comment?: string,
): SeedLocation => ({
  name,
  address,
  city: 'Chicago',
  state: 'IL',
  lat,
  lng,
  ...(comment && {comment}),
});

export const LOCATIONS = {
  ironLoop: chicago('Iron Loop Gym', '216 W Ohio St, Chicago, IL 60654', 41.8925, -87.6347),
  millennium: chicago(
    'Millennium Park Lawn',
    '201 E Randolph St, Chicago, IL 60602',
    41.8826,
    -87.6226,
    'Meet by the Bean',
  ),
  northAvenue: chicago(
    'North Avenue Beach',
    '1600 N Lake Shore Dr, Chicago, IL 60613',
    41.9118,
    -87.6262,
    'Next to lifeguard tower 4',
  ),
  montrose: chicago('Montrose Beach', '4400 N Lake Shore Dr, Chicago, IL 60640', 41.9663, -87.6378),
  lakefrontTrail: chicago(
    'Lakefront Trail at Fullerton',
    '2400 N Lake Shore Dr, Chicago, IL 60614',
    41.9257,
    -87.6339,
    'Fullerton Ave underpass',
  ),
  lincolnPark: chicago(
    'Lincoln Park South Field',
    '2045 N Lincoln Park W, Chicago, IL 60614',
    41.9203,
    -87.6359,
  ),
  westLoopBoxing: chicago(
    'West Loop Boxing Club',
    '1000 W Randolph St, Chicago, IL 60607',
    41.8843,
    -87.6527,
  ),
  northsideCrossfit: chicago(
    'Northside CrossFit',
    '3130 N Halsted St, Chicago, IL 60657',
    41.9393,
    -87.6491,
  ),
  coreStudio: chicago(
    'Core Studio Lincoln Park',
    '2210 N Clark St, Chicago, IL 60614',
    41.9227,
    -87.6383,
  ),
  lakeviewAquatic: chicago(
    'Lakeview Aquatic Center',
    '3401 N Clark St, Chicago, IL 60657',
    41.9435,
    -87.6532,
  ),
  mcFetridge: chicago(
    'McFetridge Sports Center',
    '3843 N California Ave, Chicago, IL 60618',
    41.9518,
    -87.6979,
    'Indoor courts 3-4',
  ),
  centralPark: {
    name: 'Central Park Great Lawn',
    address: 'Central Park, New York, NY 10024',
    city: 'New York',
    state: 'NY',
    lat: 40.7812,
    lng: -73.9665,
    comment: 'North end of the lawn',
  },
  southPointe: {
    name: 'South Pointe Park',
    address: '1 Washington Ave, Miami Beach, FL 33139',
    city: 'Miami',
    state: 'FL',
    lat: 25.768,
    lng: -80.1341,
  },
} satisfies Record<string, SeedLocation>;

type Weekly = {weekday: number; start: string; end: string};
const days = (weekdays: number[], start: string, end: string): Weekly[] =>
  weekdays.map(weekday => ({weekday, start, end}));

export type SeedType = {
  key: string;
  title: string;
  kind: 'individual' | 'group';
  durationMin: number;
  priceCents: number;
  capacity?: number;
  location?: SeedLocation;
  description: string;
  /** Group types: weekly schedule (weekday + local start time). */
  schedule?: {weekday: number; time: string}[];
};

export type SeedCoach = {
  email: string;
  firstName: string;
  lastName: string;
  avatar: number;
  homeArea: typeof CHICAGO | typeof NEW_YORK | typeof MIAMI;
  headline: string;
  bio: string;
  specializations: string[];
  experienceYears: number;
  certifications: {title: string; issuer: string; year: number}[];
  highlights: string[];
  languages: string[];
  rating: {average: number; count: number};
  freeCancelHours: number;
  defaultLocation: SeedLocation;
  weekly: Weekly[];
  types: SeedType[];
};

const MON_FRI = [1, 2, 3, 4, 5];

export const COACHES: SeedCoach[] = [
  {
    email: 'coach@fitbook.dev',
    firstName: 'Alex',
    lastName: 'Carter',
    avatar: 12,
    homeArea: CHICAGO,
    headline: 'Strength & conditioning coach for busy professionals',
    bio:
      'I help people with full calendars get strong, move without pain and actually enjoy training. ' +
      'Every program starts with a movement assessment, then we build simple, progressive sessions around your schedule.\n\n' +
      'Before coaching full time I competed in powerlifting and worked with a Division I track team, so I care a lot about technique and smart progression.',
    specializations: ['strength', 'hiit', 'mobility'],
    experienceYears: 9,
    certifications: [
      {title: 'Certified Strength and Conditioning Specialist (CSCS)', issuer: 'NSCA', year: 2017},
      {title: 'Certified Personal Trainer (CPT)', issuer: 'NASM', year: 2016},
      {title: 'Functional Range Conditioning Mobility Specialist', issuer: 'FRC', year: 2021},
    ],
    highlights: [
      '500+ clients coached',
      'Former D1 track strength coach',
      'Competitive powerlifter (USAPL)',
    ],
    languages: ['English', 'Spanish'],
    rating: {average: 4.9, count: 142},
    freeCancelHours: 24,
    defaultLocation: LOCATIONS.ironLoop,
    weekly: [
      ...days(MON_FRI, '06:00', '11:00'),
      ...days(MON_FRI, '16:00', '20:00'),
      ...days([6], '08:00', '12:00'),
    ],
    types: [
      {
        key: 'alex-1on1',
        title: '1:1 Strength Session',
        kind: 'individual',
        durationMin: 60,
        priceCents: 8500,
        description: 'Personal strength session with technique coaching and a plan for the week.',
      },
      {
        key: 'alex-long',
        title: '1:1 Strength + Mobility (90 min)',
        kind: 'individual',
        durationMin: 90,
        priceCents: 12000,
        description: 'Longer session: full strength block plus a guided mobility routine.',
      },
      {
        key: 'alex-circuit',
        title: 'Lunchtime Strength Circuit',
        kind: 'group',
        durationMin: 60,
        priceCents: 2500,
        capacity: 8,
        description: 'Small-group circuit with kettlebells and dumbbells. All levels welcome.',
        schedule: [
          {weekday: 1, time: '12:00'},
          {weekday: 3, time: '12:00'},
          {weekday: 5, time: '12:00'},
        ],
      },
    ],
  },
  {
    email: 'maya.patel@fitbook.dev',
    firstName: 'Maya',
    lastName: 'Patel',
    avatar: 47,
    homeArea: CHICAGO,
    headline: 'Vinyasa & mobility yoga, on the lakefront and in your living room',
    bio:
      'Yoga found me after a running injury, and it stayed because it made everything else in my life better. ' +
      'My classes blend strong vinyasa flows with mobility work and breathwork, and I adapt every pose to your body.\n\n' +
      'In summer we practice on North Avenue Beach at sunrise - bring a mat and a towel.',
    specializations: ['yoga', 'mobility'],
    experienceYears: 7,
    certifications: [
      {title: 'RYT-500 Registered Yoga Teacher', issuer: 'Yoga Alliance', year: 2020},
      {title: 'Yin Yoga Teacher Training', issuer: 'Yoga Alliance', year: 2019},
    ],
    highlights: [
      '1,000+ classes taught',
      'Runs the Sunrise Beach Yoga community',
      'Trauma-informed teaching',
    ],
    languages: ['English', 'Hindi'],
    rating: {average: 4.95, count: 188},
    freeCancelHours: 12,
    defaultLocation: LOCATIONS.millennium,
    weekly: [
      ...days([1, 2, 3, 4], '07:00', '10:00'),
      ...days([1, 3], '17:00', '20:00'),
      ...days([0], '09:00', '12:00'),
    ],
    types: [
      {
        key: 'maya-private',
        title: 'Private Vinyasa Flow',
        kind: 'individual',
        durationMin: 60,
        priceCents: 7500,
        description: 'One-on-one flow tailored to your goals and mobility.',
      },
      {
        key: 'maya-beach',
        title: 'Sunrise Beach Yoga',
        kind: 'group',
        durationMin: 60,
        priceCents: 1800,
        capacity: 15,
        location: LOCATIONS.northAvenue,
        description: 'All-levels flow on the sand as the sun comes up.',
        schedule: [
          {weekday: 6, time: '07:00'},
          {weekday: 3, time: '06:00'},
        ],
      },
    ],
  },
  {
    email: 'marcus.reed@fitbook.dev',
    firstName: 'Marcus',
    lastName: 'Reed',
    avatar: 59,
    homeArea: CHICAGO,
    headline: 'Boxing coach - technique, conditioning and confidence',
    bio:
      'I boxed for 12 years as an amateur and now coach beginners and competitors at West Loop Boxing Club. ' +
      'Sessions combine pad work, footwork and conditioning; no experience needed, gloves provided.',
    specializations: ['boxing', 'hiit'],
    experienceYears: 11,
    certifications: [
      {title: 'USA Boxing Coach Level 2', issuer: 'USA Boxing', year: 2018},
      {title: 'CPR/AED', issuer: 'American Red Cross', year: 2025},
    ],
    highlights: ['Golden Gloves finalist', 'Coached 30+ amateur fighters', 'Beginner friendly'],
    languages: ['English'],
    rating: {average: 4.8, count: 96},
    freeCancelHours: 24,
    defaultLocation: LOCATIONS.westLoopBoxing,
    weekly: [...days(MON_FRI, '15:00', '21:00'), ...days([6], '10:00', '14:00')],
    types: [
      {
        key: 'marcus-1on1',
        title: '1:1 Boxing',
        kind: 'individual',
        durationMin: 60,
        priceCents: 9000,
        description: 'Pads, footwork and combinations at your level.',
      },
      {
        key: 'marcus-group',
        title: 'Boxing Conditioning',
        kind: 'group',
        durationMin: 60,
        priceCents: 3000,
        capacity: 10,
        description: 'High-energy bag work and conditioning rounds.',
        schedule: [
          {weekday: 2, time: '18:00'},
          {weekday: 4, time: '18:00'},
        ],
      },
    ],
  },
  {
    email: 'sofia.alvarez@fitbook.dev',
    firstName: 'Sofia',
    lastName: 'Alvarez',
    avatar: 44,
    homeArea: CHICAGO,
    headline: 'Running coach - from first 5K to Chicago Marathon',
    bio:
      'Eight Chicago Marathons and a lot of miles on the Lakefront Trail taught me that consistency beats intensity. ' +
      'I coach running form, pacing and training plans for every level, and I run the Lakefront Run Club twice a week.',
    specializations: ['running', 'mobility'],
    experienceYears: 6,
    certifications: [
      {title: 'RRCA Certified Running Coach', issuer: 'Road Runners Club of America', year: 2020},
      {title: 'USATF Level 1 Coach', issuer: 'USA Track & Field', year: 2021},
    ],
    highlights: ['8x Chicago Marathon finisher', 'Boston qualifier', 'Gait analysis on video'],
    languages: ['English', 'Spanish'],
    rating: {average: 4.9, count: 77},
    freeCancelHours: 12,
    defaultLocation: LOCATIONS.lakefrontTrail,
    weekly: [
      ...days([1, 2, 3, 4, 5], '06:00', '09:00'),
      ...days([2, 4], '17:00', '19:00'),
      ...days([0], '07:00', '10:00'),
    ],
    types: [
      {
        key: 'sofia-1on1',
        title: '1:1 Run Technique',
        kind: 'individual',
        durationMin: 60,
        priceCents: 7000,
        description: 'Form drills, video gait analysis and a personal plan.',
      },
      {
        key: 'sofia-club',
        title: 'Lakefront Run Club',
        kind: 'group',
        durationMin: 60,
        priceCents: 1500,
        capacity: 15,
        description: 'Easy group run with drills and strides. 5K-8K, all paces.',
        schedule: [
          {weekday: 2, time: '19:00'},
          {weekday: 6, time: '08:00'},
        ],
      },
    ],
  },
  {
    email: 'daniel.kim@fitbook.dev',
    firstName: 'Daniel',
    lastName: 'Kim',
    avatar: 33,
    homeArea: CHICAGO,
    headline: 'CrossFit & Olympic lifting coach',
    bio:
      'I coach CrossFit classes and Olympic lifting at Northside CrossFit. I love helping people find their first ' +
      'pull-up and their first clean - safe progressions, lots of encouragement and measurable results.',
    specializations: ['crossfit', 'strength', 'hiit'],
    experienceYears: 8,
    certifications: [
      {title: 'CrossFit Level 2 Trainer (CF-L2)', issuer: 'CrossFit', year: 2019},
      {title: 'USA Weightlifting Level 1', issuer: 'USA Weightlifting', year: 2018},
    ],
    highlights: ['Coached 3 regional competitors', 'Specialist in scaling for beginners'],
    languages: ['English', 'Korean'],
    rating: {average: 4.7, count: 64},
    freeCancelHours: 48,
    defaultLocation: LOCATIONS.northsideCrossfit,
    weekly: [...days(MON_FRI, '07:00', '12:00'), ...days([6], '09:00', '13:00')],
    types: [
      {
        key: 'daniel-oly',
        title: '1:1 Olympic Lifting',
        kind: 'individual',
        durationMin: 60,
        priceCents: 9500,
        description: 'Snatch and clean & jerk technique with video feedback.',
      },
      {
        key: 'daniel-wod',
        title: 'Group WOD',
        kind: 'group',
        durationMin: 60,
        priceCents: 2800,
        capacity: 12,
        description: 'Classic CrossFit class: warm-up, skill, WOD, cool-down.',
        schedule: [
          {weekday: 1, time: '18:00'},
          {weekday: 3, time: '18:00'},
          {weekday: 6, time: '14:00'},
        ],
      },
    ],
  },
  {
    email: 'emily.novak@fitbook.dev',
    firstName: 'Emily',
    lastName: 'Novak',
    avatar: 45,
    homeArea: CHICAGO,
    headline: 'Pilates for a strong core and a happy back',
    bio:
      'Former dancer turned Pilates instructor. I specialize in core strength, posture and back-pain friendly ' +
      'programs, in private sessions or small groups of up to six people.',
    specializations: ['pilates', 'mobility'],
    experienceYears: 10,
    certifications: [
      {title: 'Comprehensive Pilates Instructor', issuer: 'STOTT PILATES', year: 2015},
      {title: 'Pre & Postnatal Pilates', issuer: 'Balanced Body', year: 2019},
    ],
    highlights: ['Former professional dancer', 'Pre/postnatal specialist', 'Small groups, max 6'],
    languages: ['English', 'Czech'],
    rating: {average: 4.85, count: 110},
    freeCancelHours: 24,
    defaultLocation: LOCATIONS.coreStudio,
    weekly: [...days([1, 2, 3, 4], '08:00', '13:00'), ...days([2, 4], '17:00', '20:00')],
    types: [
      {
        key: 'emily-private',
        title: 'Private Mat Pilates',
        kind: 'individual',
        durationMin: 60,
        priceCents: 8000,
        description: 'Personal mat session focused on core and posture.',
      },
      {
        key: 'emily-small',
        title: 'Small Group Pilates',
        kind: 'group',
        durationMin: 60,
        priceCents: 3500,
        capacity: 6,
        description: 'Intimate mat class with individual corrections.',
        schedule: [
          {weekday: 5, time: '09:00'},
          {weekday: 0, time: '10:00'},
        ],
      },
    ],
  },
  {
    email: 'chris.johnson@fitbook.dev',
    firstName: 'Chris',
    lastName: 'Johnson',
    avatar: 15,
    homeArea: CHICAGO,
    headline: 'Swim coach - stroke technique and open water',
    bio:
      'Former collegiate swimmer. I teach adults to swim with confidence, refine freestyle technique for triathletes ' +
      'and lead open-water prep at Montrose Beach in summer.',
    specializations: ['swimming'],
    experienceYears: 12,
    certifications: [
      {title: 'ASCA Level 3 Coach', issuer: 'American Swimming Coaches Association', year: 2016},
      {title: 'Water Safety Instructor', issuer: 'American Red Cross', year: 2024},
    ],
    highlights: ['NCAA Division II swimmer', 'Ironman finisher', 'Adult beginners welcome'],
    languages: ['English'],
    rating: {average: 4.9, count: 52},
    freeCancelHours: 24,
    defaultLocation: LOCATIONS.lakeviewAquatic,
    weekly: [...days([1, 3, 5], '06:00', '10:00'), ...days([2, 4], '18:00', '21:00')],
    types: [
      {
        key: 'chris-1on1',
        title: '1:1 Swim Technique',
        kind: 'individual',
        durationMin: 60,
        priceCents: 7500,
        description: 'Video-assisted stroke correction in a 25-yard pool.',
      },
      {
        key: 'chris-ow',
        title: 'Open Water Prep',
        kind: 'group',
        durationMin: 90,
        priceCents: 3500,
        capacity: 8,
        location: LOCATIONS.montrose,
        description: 'Sighting, drafting and safe open-water swimming. Wetsuit recommended.',
        schedule: [{weekday: 0, time: '07:00'}],
      },
    ],
  },
  {
    email: 'olivia.brooks@fitbook.dev',
    firstName: 'Olivia',
    lastName: 'Brooks',
    avatar: 49,
    homeArea: CHICAGO,
    headline: 'Tennis coach for adults - from first rally to league play',
    bio:
      'USPTA certified pro with a background in college tennis. Private lessons focus on clean technique and ' +
      'match strategy; Cardio Tennis is a fun workout for any level.',
    specializations: ['tennis'],
    experienceYears: 5,
    certifications: [{title: 'USPTA Professional', issuer: 'USPTA', year: 2021}],
    highlights: ['NCAA Division I player', 'USTA league captain', 'Racquets available'],
    languages: ['English', 'French'],
    rating: {average: 4.75, count: 39},
    freeCancelHours: 48,
    defaultLocation: LOCATIONS.mcFetridge,
    weekly: [...days([2, 3, 4], '16:00', '21:00'), ...days([6, 0], '09:00', '14:00')],
    types: [
      {
        key: 'olivia-private',
        title: 'Private Tennis Lesson',
        kind: 'individual',
        durationMin: 60,
        priceCents: 9500,
        description: 'Technique and strategy on an indoor court.',
      },
      {
        key: 'olivia-cardio',
        title: 'Cardio Tennis',
        kind: 'group',
        durationMin: 90,
        priceCents: 3000,
        capacity: 8,
        description: 'Drills set to music - a great workout, no matter your level.',
        schedule: [{weekday: 5, time: '18:00'}],
      },
    ],
  },
  {
    email: 'nina.rossi@fitbook.dev',
    firstName: 'Nina',
    lastName: 'Rossi',
    avatar: 26,
    homeArea: NEW_YORK,
    headline: 'Yoga & mobility in Central Park',
    bio:
      'New York based yoga teacher focused on mobility and stress relief for people who sit all day. ' +
      'Classes in Central Park from May to October, indoor studio the rest of the year.',
    specializations: ['yoga', 'mobility'],
    experienceYears: 6,
    certifications: [
      {title: 'RYT-200 Registered Yoga Teacher', issuer: 'Yoga Alliance', year: 2019},
    ],
    highlights: ['Corporate wellness programs', 'Desk-worker mobility specialist'],
    languages: ['English', 'Italian'],
    rating: {average: 4.85, count: 58},
    freeCancelHours: 24,
    defaultLocation: LOCATIONS.centralPark,
    weekly: [...days(MON_FRI, '07:00', '10:00'), ...days([6], '09:00', '12:00')],
    types: [
      {
        key: 'nina-private',
        title: 'Private Mobility Yoga',
        kind: 'individual',
        durationMin: 60,
        priceCents: 9000,
        description: 'Mobility-focused private session.',
      },
      {
        key: 'nina-park',
        title: 'Yoga in the Park',
        kind: 'group',
        durationMin: 60,
        priceCents: 2000,
        capacity: 20,
        description: 'Gentle flow on the Great Lawn.',
        schedule: [{weekday: 6, time: '08:00'}],
      },
    ],
  },
  {
    email: 'diego.santos@fitbook.dev',
    firstName: 'Diego',
    lastName: 'Santos',
    avatar: 52,
    homeArea: MIAMI,
    headline: 'Beach HIIT & boxing in Miami Beach',
    bio: 'Sunrise workouts with an ocean view. I coach HIIT and boxing fundamentals for all levels at South Pointe Park.',
    specializations: ['hiit', 'boxing'],
    experienceYears: 7,
    certifications: [{title: 'ACE Certified Personal Trainer', issuer: 'ACE', year: 2018}],
    highlights: ['Bilingual sessions', 'Beach bootcamp every weekend'],
    languages: ['English', 'Portuguese', 'Spanish'],
    rating: {average: 4.8, count: 71},
    freeCancelHours: 12,
    defaultLocation: LOCATIONS.southPointe,
    weekly: [...days(MON_FRI, '06:00', '10:00'), ...days([6, 0], '07:00', '11:00')],
    types: [
      {
        key: 'diego-1on1',
        title: '1:1 Beach HIIT',
        kind: 'individual',
        durationMin: 60,
        priceCents: 8000,
        description: 'Personal HIIT session on the sand.',
      },
      {
        key: 'diego-bootcamp',
        title: 'Beach Bootcamp',
        kind: 'group',
        durationMin: 60,
        priceCents: 2000,
        capacity: 15,
        description: 'Weekend bootcamp on the beach.',
        schedule: [
          {weekday: 6, time: '08:00'},
          {weekday: 0, time: '08:00'},
        ],
      },
    ],
  },
];

export const INCOMPLETE_COACH = {
  email: 'newcoach@fitbook.dev',
  firstName: 'Taylor',
  lastName: 'Morgan',
  avatar: 8,
  homeArea: CHICAGO,
};

export type SeedClient = {
  email: string;
  firstName: string;
  lastName: string;
  avatar: number;
  homeArea: SeedCoach['homeArea'];
};

const client = (
  firstName: string,
  lastName: string,
  avatar: number,
  homeArea: SeedCoach['homeArea'] = CHICAGO,
): SeedClient => ({
  email: `${firstName}.${lastName}@example.com`.toLowerCase(),
  firstName,
  lastName,
  avatar,
  homeArea,
});

export const DEMO_CLIENT: SeedClient = {
  email: 'client@fitbook.dev',
  firstName: 'Jamie',
  lastName: 'Lee',
  avatar: 32,
  homeArea: CHICAGO,
};
export const NEW_CLIENT: SeedClient = {
  email: 'newclient@fitbook.dev',
  firstName: 'Riley',
  lastName: 'Chen',
  avatar: 41,
  homeArea: CHICAGO,
};

export const CLIENTS: SeedClient[] = [
  client('Ava', 'Thompson', 5),
  client('Ethan', 'Brown', 11),
  client('Mia', 'Garcia', 9),
  client('Noah', 'Wilson', 14),
  client('Sophia', 'Martinez', 16),
  client('Liam', 'Anderson', 13),
  client('Isabella', 'Taylor', 20),
  client('Lucas', 'Moore', 51),
  client('Chloe', 'Jackson', 23),
  client('Mason', 'White', 53),
  client('Grace', 'Harris', 24),
  client('Logan', 'Clark', 56),
  client('Zoe', 'Lewis', 25),
  client('Elijah', 'Walker', 57),
  client('Hannah', 'Young', 29),
  client('Owen', 'King', 60),
  client('Emma', 'Wright', 31, NEW_YORK),
  client('Leo', 'Hill', 62, MIAMI),
];

export const NOTE_TEXTS = {
  clientBefore: [
    'Slept badly last night, might need an easier session.',
    'My lower back is a bit tight after the long flight.',
    'Can we work on my squat depth today?',
    'Running a 10K on Sunday - nothing too heavy on the legs please.',
    'Left knee feels a little sore, let me know what to avoid.',
    'Would love to try something new today!',
    'I will be 5 minutes late, stuck in traffic on Lake Shore Drive.',
  ],
  coachBefore: [
    'Plan: warm-up, technique block, finisher. Bring water and a towel.',
    'We will test your 5-rep max today, eat a good breakfast.',
    'Focus for today: breathing and posture.',
    'Bring running shoes, we will finish outside if the weather allows.',
  ],
  coachAfter: [
    'Great session! Next time we add 5 lb to the main lift.',
    'Huge improvement in form. Keep doing the mobility routine twice a week.',
    'Good effort. Remember: shoulders down and back during presses.',
    'You hit a new personal best today. Rest well and hydrate.',
    'Footwork is getting much sharper. Practice the drill at home for 10 minutes.',
    'Solid pace work. Next week: 2 x 10 min at tempo pace.',
  ],
  clientAfter: [
    'Thank you! Legs are sore but in a good way.',
    'Loved this one. Can we do the same finisher next time?',
    'Felt great, my back pain is almost gone.',
    'That was tough! See you next week.',
  ],
};

export const CHAT_SCRIPTS: string[][] = [
  [
    'c:Hi! I just booked my first session. Anything I should bring?',
    'k:Welcome! Comfortable clothes, training shoes and a water bottle. Everything else is at the gym.',
    'c:Perfect. Is there parking nearby?',
    'k:Yes, there is a garage on Ohio St, and street parking after 6 pm.',
    'c:Great, see you on Tuesday!',
  ],
  [
    'k:Hey! How are you feeling after yesterday?',
    'c:Sore, but happy. Stairs are interesting today :)',
    'k:Ha, that is normal. A 20-minute walk and some stretching will help a lot.',
    'c:Will do. Should I do the mobility routine today too?',
    'k:Yes, the short version is perfect.',
  ],
  [
    'c:Hi, can we move Thursday to the evening?',
    'k:Sure, I have 6 pm free. Cancel the morning one and book the 6 pm slot in the app.',
    'c:Done, thanks!',
    'k:Got it, see you at 6.',
  ],
  [
    'c:Do you think I can be ready for a half marathon in 12 weeks?',
    'k:If you can run 5 miles comfortably now - yes. Let us plan it together at our next session.',
    'c:Amazing, I can do about 4 right now.',
    'k:Close enough! We will build up gradually.',
    'c:Can you also send me a stretching routine?',
    'k:I will add it to our notes after the session.',
  ],
];
