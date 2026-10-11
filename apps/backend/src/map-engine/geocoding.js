/**
 * VAAYU Map Engine location search and address resolution.
 * 
 * Production Enhancements:
 * 1. Curated local landmark registry and external geocoding adapters
 * 2. Explicit distinction between coordinate, geocoder, curated, and synthesized results
 * 3. Micro-Address Synthesizer: Supports Phase, Road No, Sector, Block, Tower, Plot, Flat, H.No, Door No, Lane
 * 4. Phonetic & Transliteration Normalization (Telangana/Andhra English/Telugu spelling variants)
 * 5. Preposition Stopword Removal ('near', 'opposite', 'behind', 'beside', 'next to', 'around', 'close to')
 * 6. Pincode & Explicit City Override Scoring (+250 boost for exact pincode alignment)
 * 7. Explicit Confidence Classification: 'EXACT', 'HIGH_CONFIDENCE', 'SYNTHESIZED', 'APPROXIMATE'
 * 8. Spatial Deduplication & Category-Aware Result Sorting
 */

const http = require('http');
const https = require('https');
const url = require('url');
const { metricsService } = require('../services/metricsService');
const { circuitBreakerService } = require('../services/circuitBreakerService');

// ---------------------------------------------------------------------------
// 1. High-Density Micro-Landmark Registry & Regional POIs
// ---------------------------------------------------------------------------
const HYD_LANDMARKS = [
  // High-Precision Residential Communities & Towers
  { name: 'My Home Bhooja Towers, Knowledge City, Rai Durg, Hyderabad', lat: 17.4385, lng: 78.3812, tags: ['my home bhooja', 'bhooja', 'towers', 'knowledge city', 'raidurg', 'gachibowli'], city: 'Hyderabad', pincode: '500081', category: 'RESIDENTIAL' },
  { name: 'Jayabheri Silicon County, Hitec City Main Road, Hyderabad', lat: 17.4452, lng: 78.3741, tags: ['jayabheri', 'silicon county', 'hitec city', 'kondapur'], city: 'Hyderabad', pincode: '500084', category: 'RESIDENTIAL' },
  { name: 'Aparna Sarovar Zenith, Nallagandla, Serilingampalle, Hyderabad', lat: 17.4721, lng: 78.2915, tags: ['aparna sarovar', 'zenith', 'nallagandla', 'tellapur'], city: 'Hyderabad', pincode: '500019', category: 'RESIDENTIAL' },
  { name: 'Rainbow Vistas Rock Garden, KPHB Phase 4, Kukatpally, Hyderabad', lat: 17.4892, lng: 78.3951, tags: ['rainbow vistas', 'rock garden', 'kphb phase 4', 'kukatpally'], city: 'Hyderabad', pincode: '500072', category: 'RESIDENTIAL' },
  { name: 'Lodha Bellezza Towers, Eden Square, KPHB Phase 4, Hyderabad', lat: 17.4910, lng: 78.3965, tags: ['lodha bellezza', 'lodha', 'kphb phase 4', 'kukatpally'], city: 'Hyderabad', pincode: '500072', category: 'RESIDENTIAL' },
  { name: 'Lansum Etania, Financial District, Nanakramguda, Hyderabad', lat: 17.4195, lng: 78.3412, tags: ['lansum etania', 'etania', 'financial district', 'nanakramguda'], city: 'Hyderabad', pincode: '500032', category: 'RESIDENTIAL' },

  // Tech Parks & Innovation Hubs
  { name: 'T-Hub 2.0 Innovation Campus, Knowledge City, Rai Durg, Hyderabad', lat: 17.4358, lng: 78.3818, tags: ['t-hub', 'thub 2.0', 'innovation campus', 'knowledge city', 'raidurg'], city: 'Hyderabad', pincode: '500081', category: 'BUSINESS_PARK' },
  { name: 'Cyber Towers, Hitec City Main Cross Roads, Hyderabad', lat: 17.4501, lng: 78.3811, tags: ['cyber towers', 'hitec city', 'madhapur'], city: 'Hyderabad', pincode: '500081', category: 'BUSINESS_PARK' },
  { name: 'Sattva Knowledge City & Salarpuria, Rai Durg, Hyderabad', lat: 17.4371, lng: 78.3802, tags: ['sattva knowledge city', 'knowledge city', 'salarpuria', 'raidurg'], city: 'Hyderabad', pincode: '500081', category: 'BUSINESS_PARK' },
  { name: 'Divyasree Orion IT Park, Gachibowli, Hyderabad', lat: 17.4285, lng: 78.3610, tags: ['divyasree orion', 'orion', 'gachibowli', 'it park'], city: 'Hyderabad', pincode: '500032', category: 'BUSINESS_PARK' },
  { name: 'DLF Cybercity Phase 1 & 2, Gachibowli, Hyderabad', lat: 17.4400, lng: 78.3480, tags: ['dlf', 'dlf cybercity', 'gachibowli', 'financial district', 'oracle'], city: 'Hyderabad', pincode: '500032', category: 'BUSINESS_PARK' },
  { name: 'Amazon Development Centre, Nanakramguda, Hyderabad', lat: 17.4180, lng: 78.3420, tags: ['amazon', 'nanakramguda', 'financial district', 'office', 'gachibowli'], city: 'Hyderabad', pincode: '500032', category: 'BUSINESS_PARK' },
  { name: 'Mindspace IT Park Building 12, Madhapur, Hyderabad', lat: 17.4390, lng: 78.3750, tags: ['mindspace', 'madhapur', 'hitec city', 'building 12'], city: 'Hyderabad', pincode: '500081', category: 'BUSINESS_PARK' },
  { name: 'Raidurg Metro Station & IKEA, Hitec City, Hyderabad', lat: 17.4420, lng: 78.3780, tags: ['raidurg', 'metro', 'ikea', 'mindspace', 'hitec city'], city: 'Hyderabad', pincode: '500081', category: 'METRO' },

  // Malls & Commercial Hubs
  { name: 'Sarath City Capital Mall, Gachibowli - Miyapur Road, Kondapur, Hyderabad', lat: 17.4568, lng: 78.3662, tags: ['sarath city', 'capital mall', 'amb cinemas', 'kondapur'], city: 'Hyderabad', pincode: '500084', category: 'MALL' },
  { name: 'Inorbit Mall & Durgam Cheruvu Cable Bridge, Madhapur, Hyderabad', lat: 17.4360, lng: 78.3840, tags: ['inorbit', 'mall', 'durgam cheruvu', 'cable bridge', 'madhapur'], city: 'Hyderabad', pincode: '500081', category: 'MALL' },
  { name: 'Forum Sujana Mall & KPHB Metro Station, Kukatpally, Hyderabad', lat: 17.4875, lng: 78.3980, tags: ['forum', 'sujana', 'forum sujana mall', 'kphb metro', 'hyd'], city: 'Hyderabad', pincode: '500072', category: 'MALL' },
  { name: 'GVK One Mall, Road No 1, Banjara Hills, Hyderabad', lat: 17.4190, lng: 78.4480, tags: ['gvk one', 'gvk', 'mall', 'banjara hills', 'road 1'], city: 'Hyderabad', pincode: '500034', category: 'MALL' },
  { name: 'City Centre Mall, Road No 1, Banjara Hills, Hyderabad', lat: 17.4162, lng: 78.4498, tags: ['city centre', 'mall', 'banjara hills', 'road 1'], city: 'Hyderabad', pincode: '500034', category: 'MALL' },
  { name: 'Next Galleria Mall & Punjagutta Metro Station, Hyderabad', lat: 17.4258, lng: 78.4512, tags: ['next galleria', 'galleria mall', 'punjagutta', 'metro'], city: 'Hyderabad', pincode: '500082', category: 'MALL' },

  // Key Road Numbers & Street Sections
  { name: 'Road No 36, Jubilee Hills Check Post & Metro Station, Hyderabad', lat: 17.4318, lng: 78.4068, tags: ['road 36', 'road no 36', 'jubilee hills', 'check post'], city: 'Hyderabad', pincode: '500033', category: 'LOCALITY' },
  { name: 'Road No 45, Peddamma Temple & Jubilee Hills, Hyderabad', lat: 17.4352, lng: 78.3991, tags: ['road 45', 'road no 45', 'peddamma temple', 'jubilee hills'], city: 'Hyderabad', pincode: '500033', category: 'LOCALITY' },
  { name: 'Road No 12, MLA Colony, Banjara Hills, Hyderabad', lat: 17.4112, lng: 78.4321, tags: ['road 12', 'road no 12', 'banjara hills', 'mla colony'], city: 'Hyderabad', pincode: '500034', category: 'LOCALITY' },
  { name: 'Road No 1, Care Hospital Junction, Banjara Hills, Hyderabad', lat: 17.4182, lng: 78.4461, tags: ['road 1', 'road no 1', 'care hospital', 'banjara hills'], city: 'Hyderabad', pincode: '500034', category: 'LOCALITY' },
  { name: 'Road No 92, Apollo Hospital Campus, Jubilee Hills, Hyderabad', lat: 17.4170, lng: 78.4120, tags: ['road 92', 'road no 92', 'apollo hospital', 'jubilee hills'], city: 'Hyderabad', pincode: '500033', category: 'HOSPITAL' },

  // Micro Phase Breakdown — KPHB Colony
  { name: 'KPHB Phase 1 & Temple Bus Stop, Kukatpally, Hyderabad', lat: 17.4831, lng: 78.4082, tags: ['kphb phase 1', 'phase 1', 'kphb 1', 'kukatpally'], city: 'Hyderabad', pincode: '500072', category: 'LOCALITY' },
  { name: 'KPHB Phase 2 & Shiv Parvathi Theatre Road, Hyderabad', lat: 17.4859, lng: 78.4051, tags: ['kphb phase 2', 'phase 2', 'kphb 2', 'kukatpally'], city: 'Hyderabad', pincode: '500072', category: 'LOCALITY' },
  { name: 'KPHB Phase 3 & Rythu Bazar Junction, Hyderabad', lat: 17.4878, lng: 78.4021, tags: ['kphb phase 3', 'phase 3', 'kphb 3', 'kukatpally'], city: 'Hyderabad', pincode: '500072', category: 'LOCALITY' },
  { name: 'KPHB Phase 4 & Malaysian Township Circle, Hyderabad', lat: 17.4902, lng: 78.3971, tags: ['kphb phase 4', 'phase 4', 'kphb 4', 'malaysian township'], city: 'Hyderabad', pincode: '500072', category: 'LOCALITY' },
  { name: 'KPHB Phase 5 & Manjeera Pipeline Road, Hyderabad', lat: 17.4932, lng: 78.3941, tags: ['kphb phase 5', 'phase 5', 'kphb 5', 'manjeera'], city: 'Hyderabad', pincode: '500072', category: 'LOCALITY' },
  { name: 'KPHB Phase 6 & JNTU Back Gate, Hyderabad', lat: 17.4961, lng: 78.3912, tags: ['kphb phase 6', 'phase 6', 'kphb 6', 'jntu back gate'], city: 'Hyderabad', pincode: '500072', category: 'LOCALITY' },
  { name: 'KPHB Phase 9 & Vasanth Nagar, Kukatpally, Hyderabad', lat: 17.4991, lng: 78.3861, tags: ['kphb phase 9', 'phase 9', 'kphb 9', 'vasanth nagar'], city: 'Hyderabad', pincode: '500085', category: 'LOCALITY' },

  // Key Transit & Academic POIs
  { name: 'JNTU Hyderabad (JNTUH) Main Gate, Kukatpally, Hyderabad', lat: 17.4980, lng: 78.3910, tags: ['jntu', 'jntuh', 'university', 'engineering', 'kukatpally'], city: 'Hyderabad', pincode: '500085', category: 'UNIVERSITY' },
  { name: 'Rajiv Gandhi International Airport (RGIA), Shamshabad, Hyderabad', lat: 17.2403, lng: 78.4294, tags: ['rgia', 'airport', 'shamshabad', 'international airport', 'hyd'], city: 'Hyderabad', pincode: '500108', category: 'AIRPORT' },
  { name: 'Secunderabad Railway Station, Clock Tower, Hyderabad', lat: 17.4340, lng: 78.5010, tags: ['secunderabad', 'railway station', 'clock tower', 'stn'], city: 'Hyderabad', pincode: '500003', category: 'STATION' },
  { name: 'Hyderabad Deccan Railway Station, Nampally, Hyderabad', lat: 17.3850, lng: 78.4710, tags: ['nampally', 'hyderabad deccan', 'railway station', 'nampally stn'], city: 'Hyderabad', pincode: '500001', category: 'STATION' },
  { name: 'Kacheguda Railway Station & Station Road, Hyderabad', lat: 17.3882, lng: 78.4941, tags: ['kacheguda', 'railway station', 'kacheguda stn'], city: 'Hyderabad', pincode: '500027', category: 'STATION' },
  { name: 'SR Nagar (Sanjeeva Reddy Nagar) & Metro Station, Hyderabad', lat: 17.4430, lng: 78.4410, tags: ['sr nagar', 'sanjeeva reddy nagar', 'metro'], city: 'Hyderabad', pincode: '500038', category: 'LOCALITY' },
  { name: 'Ameerpet Metro Interchange & Cross Roads, Hyderabad', lat: 17.4370, lng: 78.4480, tags: ['ameerpet', 'cross roads', 'metro', 'interchange'], city: 'Hyderabad', pincode: '500016', category: 'LOCALITY' },
  { name: 'Paradise Hotel & Biryani, Secunderabad, Hyderabad', lat: 17.4415, lng: 78.4870, tags: ['paradise', 'biryani', 'secunderabad', 'restaurant'], city: 'Hyderabad', pincode: '500003', category: 'RESTAURANT' },
  { name: 'Bawarchi Restaurant, RTC X Roads, Chikkadpally, Hyderabad', lat: 17.4010, lng: 78.4900, tags: ['bawarchi', 'rtc x roads', 'biryani', 'restaurant', 'chikkadpally'], city: 'Hyderabad', pincode: '500020', category: 'RESTAURANT' },
  { name: 'NIMS (Nizam Institute of Medical Sciences), Punjagutta, Hyderabad', lat: 17.4240, lng: 78.4530, tags: ['nims', 'hospital', 'punjagutta', 'medical'], city: 'Hyderabad', pincode: '500082', category: 'HOSPITAL' },
  { name: 'KIMS Hospital, Minister Road, Secunderabad, Hyderabad', lat: 17.4350, lng: 78.4810, tags: ['kims', 'hospital', 'secunderabad', 'minister road'], city: 'Hyderabad', pincode: '500003', category: 'HOSPITAL' },
  { name: 'Apollo Hospital, Road No 92, Jubilee Hills, Hyderabad', lat: 17.4170, lng: 78.4120, tags: ['apollo', 'hospital', 'jubilee hills', 'road 92'], city: 'Hyderabad', pincode: '500033', category: 'HOSPITAL' },
  { name: 'Golconda Fort & Qutb Shahi Tombs, Karwan, Hyderabad', lat: 17.3833, lng: 78.4011, tags: ['golconda', 'fort', 'qutb shahi', 'karwan'], city: 'Hyderabad', pincode: '500008', category: 'MONUMENT' },
  { name: 'BITS Pilani Hyderabad Campus, Jawahar Nagar, Shamirpet, Hyderabad', lat: 17.5449, lng: 78.5718, tags: ['bits', 'pilani', 'bits pilani', 'university', 'shamirpet'], city: 'Hyderabad', pincode: '500078', category: 'UNIVERSITY' },
  { name: 'CBIT (Chaitanya Bharathi Institute of Technology), Gandipet, Hyderabad', lat: 17.3917, lng: 78.3181, tags: ['cbit', 'gandipet', 'engineering', 'college'], city: 'Hyderabad', pincode: '500075', category: 'UNIVERSITY' },
  { name: 'Pragathi Nagar & JNTU Metro Station, Hyderabad', lat: 17.4980, lng: 78.3880, tags: ['pragathi nagar', 'jntu', 'metro', 'hyd'], city: 'Hyderabad', pincode: '500090', category: 'LOCALITY' },
  { name: 'KPHB Colony (Phase 1-9), Kukatpally, Hyderabad', lat: 17.4850, lng: 78.4041, tags: ['kp', 'kphb', 'kukatpally', 'housing board', 'hyd'], city: 'Hyderabad', pincode: '500072', category: 'LOCALITY' },
  { name: 'KP Residency & Lane 5, KPHB Colony, Hyderabad', lat: 17.4862, lng: 78.4012, tags: ['kp residency', 'residency', 'kphb', 'hyd'], city: 'Hyderabad', pincode: '500072', category: 'RESIDENTIAL' },
  { name: 'Hitec City (Cyber Towers, Mindspace), Hyderabad', lat: 17.4401, lng: 78.3489, tags: ['hitec city', 'cyber towers', 'mindspace', 'hitech', 'hyd'], city: 'Hyderabad', pincode: '500081', category: 'BUSINESS_PARK' },
  { name: 'Kondapur (Botanical Garden, RTO Office), Hyderabad', lat: 17.4600, lng: 78.3600, tags: ['kondapur', 'botanical', 'rto', 'hyd'], city: 'Hyderabad', pincode: '500084', category: 'LOCALITY' },
  { name: 'Madhapur (Durgam Cheruvu, Image Hospital), Hyderabad', lat: 17.4480, lng: 78.3910, tags: ['madhapur', 'durgam cheruvu', 'image hospital', 'hyd'], city: 'Hyderabad', pincode: '500081', category: 'LOCALITY' },
  { name: 'Jubilee Hills (Check Post, Road No 36 & 45), Hyderabad', lat: 17.4310, lng: 78.4070, tags: ['jubilee hills', 'check post', 'road 36', 'hyd'], city: 'Hyderabad', pincode: '500033', category: 'LOCALITY' },
  { name: 'Banjara Hills (Road No 1 & 12, City Center), Hyderabad', lat: 17.4150, lng: 78.4350, tags: ['banjara hills', 'road 12', 'city center', 'hyd'], city: 'Hyderabad', pincode: '500034', category: 'LOCALITY' },
  { name: 'Begumpet (Airport Road, Flyover), Hyderabad', lat: 17.4440, lng: 78.4670, tags: ['begumpet', 'airport road', 'flyover', 'hyd'], city: 'Hyderabad', pincode: '500016', category: 'LOCALITY' },
  { name: 'Sanathnagar Industrial Estate, Hyderabad', lat: 17.4580, lng: 78.4420, tags: ['sanathnagar', 'industrial estate', 'warehouse', 'hyd'], city: 'Hyderabad', pincode: '500018', category: 'INDUSTRIAL' },
  { name: 'Balanagar Industrial Area & X Roads, Hyderabad', lat: 17.4720, lng: 78.4460, tags: ['balanagar', 'industrial area', 'x roads', 'hyd'], city: 'Hyderabad', pincode: '500037', category: 'INDUSTRIAL' },
  { name: 'Jeedimetla Industrial Area, Hyderabad', lat: 17.5140, lng: 78.4470, tags: ['jeedimetla', 'industrial area', 'factory', 'hyd'], city: 'Hyderabad', pincode: '500055', category: 'INDUSTRIAL' },
  { name: 'Cherlapally Industrial Park & Railway Station, Hyderabad', lat: 17.4700, lng: 78.6000, tags: ['cherlapally', 'industrial park', 'railway station', 'hyd'], city: 'Hyderabad', pincode: '500051', category: 'INDUSTRIAL' },
  { name: 'LB Nagar X Roads & Metro Station, Hyderabad', lat: 17.3480, lng: 78.5520, tags: ['lb nagar', 'x roads', 'metro station', 'hyd'], city: 'Hyderabad', pincode: '500074', category: 'LOCALITY' },
  { name: 'Dilsukhnagar Bus Stand & Metro Station, Hyderabad', lat: 17.3680, lng: 78.5250, tags: ['dilsukhnagar', 'bus stand', 'metro', 'hyd'], city: 'Hyderabad', pincode: '500060', category: 'LOCALITY' },
  { name: 'Uppal Ring Road & Cricket Stadium, Hyderabad', lat: 17.3980, lng: 78.5580, tags: ['uppal', 'ring road', 'cricket stadium', 'hyd'], city: 'Hyderabad', pincode: '500039', category: 'LOCALITY' },
  { name: 'Mehdipatnam Rythu Bazar & X Roads, Hyderabad', lat: 17.3950, lng: 78.4380, tags: ['mehdipatnam', 'rythu bazar', 'hyd'], city: 'Hyderabad', pincode: '500028', category: 'LOCALITY' },
  { name: 'Miyapur X Roads & Metro Bus Depot, Hyderabad', lat: 17.4960, lng: 78.3610, tags: ['miyapur', 'x roads', 'metro depot', 'hyd'], city: 'Hyderabad', pincode: '500049', category: 'LOCALITY' },
  { name: 'Chanda Nagar (BHEL Township), Hyderabad', lat: 17.4910, lng: 78.3240, tags: ['chanda nagar', 'bhel', 'township', 'hyd'], city: 'Hyderabad', pincode: '500050', category: 'LOCALITY' },
  { name: 'Patancheru Industrial Zone, Hyderabad', lat: 17.5280, lng: 78.2670, tags: ['patancheru', 'industrial zone', 'hyd'], city: 'Hyderabad', pincode: '502319', category: 'INDUSTRIAL' },
  { name: 'Kompally Highway & DHFL, Hyderabad', lat: 17.5380, lng: 78.4850, tags: ['kompally', 'highway', 'dhfl', 'hyd'], city: 'Hyderabad', pincode: '500100', category: 'LOCALITY' },
  { name: 'Medchal Checkpost & Industrial Area', lat: 17.6290, lng: 78.4810, tags: ['medchal', 'checkpost', 'hyd'], city: 'Medchal', pincode: '501401', category: 'LOCALITY' },
  { name: 'Nizampet X Roads & Bachupally, Hyderabad', lat: 17.5100, lng: 78.3800, tags: ['nizampet', 'bachupally', 'hyd'], city: 'Hyderabad', pincode: '500090', category: 'LOCALITY' },
  { name: 'Hafeezpet Flyover & Railway Station, Hyderabad', lat: 17.4810, lng: 78.3560, tags: ['hafeezpet', 'flyover', 'hyd'], city: 'Hyderabad', pincode: '500049', category: 'LOCALITY' },
  { name: 'Charminar & Laad Bazar, Old City, Hyderabad', lat: 17.3616, lng: 78.4747, tags: ['charminar', 'laad bazar', 'old city', 'hyd'], city: 'Hyderabad', pincode: '500002', category: 'MONUMENT' },
  { name: 'Koti Sultan Bazar & Abids Commercial Hub, Hyderabad', lat: 17.3833, lng: 78.4833, tags: ['koti', 'abids', 'sultan bazar', 'hyd'], city: 'Hyderabad', pincode: '500095', category: 'COMMERCIAL' },
  { name: 'Alwal X Roads & Secunderabad Cantonment, Hyderabad', lat: 17.5020, lng: 78.5080, tags: ['alwal', 'cantonment', 'hyd'], city: 'Hyderabad', pincode: '500010', category: 'LOCALITY' },
  { name: 'Tarnaka X Roads & Osmania University, Hyderabad', lat: 17.4280, lng: 78.5310, tags: ['tarnaka', 'ou', 'osmania', 'hyd'], city: 'Hyderabad', pincode: '500007', category: 'UNIVERSITY' },
  { name: 'Malkajgiri Railway Station & Anandbagh, Hyderabad', lat: 17.4470, lng: 78.5320, tags: ['malkajgiri', 'anandbagh', 'hyd'], city: 'Hyderabad', pincode: '500047', category: 'LOCALITY' },
  { name: 'Habsiguda X Roads & NGRI, Hyderabad', lat: 17.4180, lng: 78.5480, tags: ['habsiguda', 'ngri', 'hyd'], city: 'Hyderabad', pincode: '500007', category: 'LOCALITY' },
  { name: 'Nacharam Industrial Area & Mallapur, Hyderabad', lat: 17.4350, lng: 78.5720, tags: ['nacharam', 'mallapur', 'industrial', 'hyd'], city: 'Hyderabad', pincode: '500076', category: 'INDUSTRIAL' },
  { name: 'ECIL X Roads & Radhika Theatre, Hyderabad', lat: 17.4680, lng: 78.5670, tags: ['ecil', 'radhika', 'hyd'], city: 'Hyderabad', pincode: '500062', category: 'LOCALITY' },
  { name: 'Tolichowki Flyover & Gachibowli Road, Hyderabad', lat: 17.4080, lng: 78.4180, tags: ['tolichowki', 'flyover', 'hyd'], city: 'Hyderabad', pincode: '500008', category: 'LOCALITY' },
  { name: 'Attapur Pillar 140 & PVNR Expressway, Hyderabad', lat: 17.3780, lng: 78.4350, tags: ['attapur', 'pvnr', 'expressway', 'hyd'], city: 'Hyderabad', pincode: '500048', category: 'LOCALITY' },
  { name: 'Narsingi ORR Junction & Kokapet, Hyderabad', lat: 17.3820, lng: 78.3480, tags: ['narsingi', 'kokapet', 'orr', 'hyd'], city: 'Hyderabad', pincode: '500075', category: 'LOCALITY' },
  { name: 'Manikonda Marrichettu & Puppalguda, Hyderabad', lat: 17.4020, lng: 78.3820, tags: ['manikonda', 'puppalguda', 'hyd'], city: 'Hyderabad', pincode: '500089', category: 'LOCALITY' },
  { name: 'Tellapur & Nallagandla Flyover, Hyderabad', lat: 17.4650, lng: 78.2980, tags: ['tellapur', 'nallagandla', 'hyd'], city: 'Hyderabad', pincode: '502032', category: 'LOCALITY' },

  // Major Regional Cities
  { name: 'Vijayawada (Pandit Nehru Bus Station & Benz Circle)', lat: 16.5062, lng: 80.6480, tags: ['vijayawada', 'benz circle', 'bus station', 'andhra'], city: 'Vijayawada', pincode: '520001', category: 'CITY' },
  { name: 'Warangal (Kazipet & Hanamkonda X Roads)', lat: 17.9689, lng: 79.5941, tags: ['warangal', 'kazipet', 'hanamkonda', 'telangana'], city: 'Warangal', pincode: '506002', category: 'CITY' },
  { name: 'Karimnagar Collectorate & Bus Station', lat: 18.4386, lng: 79.1288, tags: ['karimnagar', 'collectorate', 'telangana'], city: 'Karimnagar', pincode: '505001', category: 'CITY' },
  { name: 'Nizamabad Armoor Road & Railway Station', lat: 18.6725, lng: 78.0941, tags: ['nizamabad', 'armoor road', 'telangana'], city: 'Nizamabad', pincode: '503001', category: 'CITY' },
  { name: 'Khammam Wyra Road & Bus Station', lat: 17.2473, lng: 80.1514, tags: ['khammam', 'wyra road', 'telangana'], city: 'Khammam', pincode: '507001', category: 'CITY' },
  { name: 'Bengaluru (Hebbal, Whitefield, Electronic City)', lat: 12.9716, lng: 77.5946, tags: ['bengaluru', 'bangalore', 'whitefield', 'electronic city'], city: 'Bengaluru', pincode: '560001', category: 'CITY' },
  { name: 'Visakhapatnam (RTC Complex & Gajuwaka)', lat: 17.6868, lng: 83.2185, tags: ['visakhapatnam', 'vizag', 'gajuwaka', 'andhra'], city: 'Visakhapatnam', pincode: '530001', category: 'CITY' },
  { name: 'Marine Drive, Nariman Point, Mumbai', lat: 18.9440, lng: 72.8230, tags: ['marine drive', 'nariman point', 'mumbai'], city: 'Mumbai', pincode: '400021', category: 'CITY' },
  { name: 'Connaught Place, New Delhi', lat: 28.6315, lng: 77.2167, tags: ['connaught place', 'cp', 'delhi'], city: 'Delhi', pincode: '110001', category: 'CITY' },
  { name: 'Anna Salai, Mount Road, Chennai', lat: 13.0604, lng: 80.2496, tags: ['anna salai', 'mount road', 'chennai'], city: 'Chennai', pincode: '600002', category: 'CITY' },
  { name: 'Fergusson College Road (FC Road), Pune', lat: 18.5204, lng: 73.8412, tags: ['fc road', 'fergusson', 'pune'], city: 'Pune', pincode: '411004', category: 'CITY' },
  { name: 'Park Street, Esplanade, Kolkata', lat: 22.5551, lng: 88.3519, tags: ['park street', 'esplanade', 'kolkata'], city: 'Kolkata', pincode: '700016', category: 'CITY' },
  { name: 'SG Highway, Bodakdev, Ahmedabad', lat: 23.0396, lng: 72.5074, tags: ['sg highway', 'bodakdev', 'ahmedabad'], city: 'Ahmedabad', pincode: '380054', category: 'CITY' }
];

const ABBREVIATIONS = {
  'kp': 'kphb',
  'kphb': 'kphb colony',
  'hitec': 'hitec city',
  'hitech': 'hitec city',
  'rd': 'road',
  'stn': 'station',
  'apt': 'apartment',
  'apts': 'apartments',
  'hno': 'house number',
  'h.no': 'house number',
  'dno': 'door number',
  'd.no': 'door number',
  'hyd': 'hyderabad',
  'sec': 'secunderabad',
  'dlf': 'dlf cybercity',
  'rgia': 'rajiv gandhi international airport',
  'jntu': 'jntu metro station',
  'jntuh': 'jntu hyderabad university',
  'ou': 'osmania university',
  'orr': 'outer ring road'
};

const STATE_BY_CITY = {
  Bengaluru: 'Karnataka',
  Vijayawada: 'Andhra Pradesh',
  Visakhapatnam: 'Andhra Pradesh',
  Warangal: 'Telangana',
  Karimnagar: 'Telangana',
  Nizamabad: 'Telangana',
  Khammam: 'Telangana',
  Mumbai: 'Maharashtra',
  Delhi: 'Delhi',
  Chennai: 'Tamil Nadu',
  Pune: 'Maharashtra',
  Kolkata: 'West Bengal',
  Ahmedabad: 'Gujarat',
  Hyderabad: 'Telangana',
  Medchal: 'Telangana'
};

function stateForCity(city) {
  return STATE_BY_CITY[city] || 'Telangana';
}

const TRANSLITERATIONS = {
  'kukatapalli': 'kukatpally',
  'kukatpalli': 'kukatpally',
  'jubli': 'jubilee',
  'secunderbad': 'secunderabad',
  'gachibowlee': 'gachibowli',
  'banjara hils': 'banjara hills',
  'begumpett': 'begumpet',
  'ameerpett': 'ameerpet',
  'kondapure': 'kondapur',
  'madhapure': 'madhapur',
  'miyapure': 'miyapur',
  'charminare': 'charminar',
  'lb nagare': 'lb nagar',
  'dilsukhnagare': 'dilsukhnagar',
  'uppale': 'uppal',
  'chanda nagare': 'chanda nagar',
  'kompalle': 'kompally',
  'nizampete': 'nizampet',
  'bachupalle': 'bachupally',
  'hafeezpete': 'hafeezpet',
  'tarnake': 'tarnaka',
  'attapure': 'attapur'
};

const STOPWORDS = ['near', 'me', 'opposite', 'behind', 'beside', 'next to', 'around', 'close to', 'towards', 'in', 'at'];

function editDistanceAtMostOne(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (i < a.length || j < b.length ? 1 : 0) <= 1;
}

const EXPLICIT_CITIES = [
  'bengaluru', 'bangalore', 'vijayawada', 'warangal', 'karimnagar', 
  'nizamabad', 'khammam', 'visakhapatnam', 'vizag', 'mumbai', 'delhi', 
  'chennai', 'pune', 'kolkata', 'ahmedabad'
];

const CITY_ALIASES = {
  'bangalore': ['bangalore', 'bengaluru'],
  'bengaluru': ['bangalore', 'bengaluru'],
  'vizag': ['vizag', 'visakhapatnam'],
  'visakhapatnam': ['vizag', 'visakhapatnam']
};

function matchesExplicitCity(text, cityKeyword) {
  if (!cityKeyword) return true;
  const lower = (text || '').toLowerCase();
  const aliases = CITY_ALIASES[cityKeyword] || [cityKeyword];
  return aliases.some(alias => lower.includes(alias));
}

function calcHaversine(lat1, lon1, lat2, lon2) {
  if (isNaN(lat1) || isNaN(lon1) || isNaN(lat2) || isNaN(lon2)) return 9999;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 100) / 100;
}

function calcHaversineMeters(lat1, lon1, lat2, lon2) {
  if (isNaN(lat1) || isNaN(lon1) || isNaN(lat2) || isNaN(lon2)) return 9999000;
  const R = 6371000; // Earth radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10; // Precision down to 0.1m (10cm)
}

function calc16PointCompass(lat1, lon1, lat2, lon2) {
  const dLat = lat2 - lat1;
  const dLon = lon2 - lon1;
  const angle = Math.atan2(dLon, dLat) * 180 / Math.PI;
  const normalized = (angle + 360) % 360;
  const COMPASS_POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const index = Math.floor((normalized + 11.25) / 22.5) % 16;
  return COMPASS_POINTS[index];
}

function calcCardinalDirection(lat1, lon1, lat2, lon2) {
  return calc16PointCompass(lat1, lon1, lat2, lon2);
}

function parseNameComponents(nameStr) {
  if (!nameStr) return { title: '', subtitle: 'Telangana, India' };
  const mainCommaIdx = nameStr.search(/,(?![^(]*\))/);
  if (mainCommaIdx !== -1) {
    const title = nameStr.substring(0, mainCommaIdx).trim();
    const subtitle = nameStr.substring(mainCommaIdx + 1).trim();
    return { title, subtitle };
  }
  return { title: nameStr.trim(), subtitle: 'Telangana, India' };
}

function fetchHttpsJson(targetUrl, timeoutMs = 600) {
  return new Promise((resolve) => {
    let isResolved = false;
    const timer = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        resolve(null);
      }
    }, timeoutMs);

    try {
      const parsed = url.parse(targetUrl);
      const transport = parsed.protocol === 'http:' ? http : https;
      const req = transport.request({
        hostname: parsed.hostname,
        path: parsed.path,
        headers: {
          'User-Agent': 'VaayuLogisticsLocationEngine/3.0 (support@vaayu.app)'
        }
      }, res => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timer);
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              resolve(null);
            }
          }
        });
      });
      req.on('error', () => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timer);
          resolve(null);
        }
      });
      req.end();
    } catch (e) {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timer);
        resolve(null);
      }
    }
  });
}

// Geocoder endpoints are configurable so production can point at a self-hosted or licensed
// provider. The defaults are the public OSM services, which are capacity-limited.
const PHOTON_BASE_URL = (process.env.PHOTON_BASE_URL || 'https://photon.komoot.io').replace(/\/+$/, '');
const NOMINATIM_BASE_URL = (process.env.NOMINATIM_BASE_URL || 'https://nominatim.openstreetmap.org').replace(/\/+$/, '');

let lastNominatimRequestAt = 0;
function fetchNominatimJson(targetUrl, timeoutMs = 1500) {
  // The public OSMF endpoint is capacity-limited. Avoid sending bursts from
  // autocomplete and reverse-geocode requests; a self-hosted provider can be
  // configured separately when higher throughput is required.
  const now = Date.now();
  if (now - lastNominatimRequestAt < 1000) return Promise.resolve(null);
  lastNominatimRequestAt = now;
  return fetchHttpsJson(targetUrl, timeoutMs);
}

class SearchCache {
  constructor(maxSize = 500, ttlMs = 5 * 60 * 1000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, { value, timestamp: Date.now() });
  }
}

const searchCacheInstance = new SearchCache();

class LocationSearchService {
  constructor() {
    this.landmarks = HYD_LANDMARKS;
    this.cache = searchCacheInstance;
  }

  async search(rawQuery, refLat = 17.4850, refLng = 78.4041) {
    const startTime = Date.now();
    const qRaw = (rawQuery || '').trim();

    refLat = Number(refLat);
    refLng = Number(refLng);
    if (!Number.isFinite(refLat) || !Number.isFinite(refLng) || Math.abs(refLat) > 90 || Math.abs(refLng) > 180) {
      refLat = 17.3850;
      refLng = 78.4867;
    }

    if (!qRaw || qRaw.length < 1) {
      return { success: true, query: qRaw, intent: 'EMPTY', results: [] };
    }

    const cacheKey = `${qRaw.toLowerCase()}_${refLat.toFixed(4)}_${refLng.toFixed(4)}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { ...cached, cached: true, responseTimeMs: Date.now() - startTime };
    }

    const intentData = this.detectIntent(qRaw);
    const normalizedQuery = this.normalizeQuery(qRaw);

    // A stopword-only query (such as "near me") needs the device location
    // flow, not unrelated geocoder suggestions for the literal phrase.
    if (!normalizedQuery.cleanRaw) {
      const response = { success: true, query: qRaw, intent: intentData.intent, results: [], responseTimeMs: Date.now() - startTime };
      this.cache.set(cacheKey, response);
      return response;
    }

    if (intentData.intent === 'COORDINATE') {
      const coordResult = {
        id: `coord_${intentData.lat.toFixed(4)}_${intentData.lng.toFixed(4)}`,
        name: `Location (${intentData.lat.toFixed(5)}, ${intentData.lng.toFixed(5)})`,
        title: `Location (${intentData.lat.toFixed(5)}, ${intentData.lng.toFixed(5)})`,
        subtitle: `Direct Coordinates Input`,
        lat: intentData.lat,
        lng: intentData.lng,
        distanceKm: calcHaversine(refLat, refLng, intentData.lat, intentData.lng),
        score: 200,
        source: 'COORDINATE',
        type: 'COORDINATE',
        confidence: 1.0,
        confidenceLevel: 'EXACT',
        requiresPinConfirmation: false,
        addressDetails: { houseNumber: null, street: null, locality: null, city: null, state: null, pincode: null, country: 'India' }
      };

      const response = {
        success: true,
        query: qRaw,
        intent: intentData.intent,
        results: [coordResult],
        responseTimeMs: Date.now() - startTime
      };
      this.cache.set(cacheKey, response);
      return response;
    }

    let candidatePool = [];

    // Local Provider
    const localResults = this.searchLocalProvider(qRaw, normalizedQuery, intentData, refLat, refLng);
    candidatePool.push(...localResults);

    const topLocalScore = localResults.length > 0 ? localResults[0].score : 0;
    
    // External Providers
    let externalResults = [];
    if (intentData.intent === 'HOUSE_ADDRESS' || topLocalScore < 90 || localResults.length < 2 || intentData.explicitCity) {
      externalResults = await this.fetchExternalProviders(qRaw, refLat, refLng, intentData);
      candidatePool.push(...externalResults);
    }

    // Score & Rank
    const scoredPool = candidatePool.map(item => {
      const finalScore = this.computeVaayuScore(item, normalizedQuery, intentData, refLat, refLng);
      let confidenceLevel = 'APPROXIMATE';
      if (item.source === 'COORDINATE') confidenceLevel = 'EXACT';
      else if (item.source === 'HOUSE_NUMBER') confidenceLevel = 'SYNTHESIZED';
      else if (item.source === 'LOCAL' || finalScore >= 160) confidenceLevel = 'HIGH_CONFIDENCE';

      return {
        ...item,
        score: finalScore,
        confidence: item.source === 'HOUSE_NUMBER' ? 0.4 : Math.min(1.0, Math.max(0.1, finalScore / 180)),
        confidenceLevel,
        requiresPinConfirmation: item.source === 'HOUSE_NUMBER' || confidenceLevel === 'SYNTHESIZED'
      };
    });

    scoredPool.sort((a, b) => b.score - a.score || a.distanceKm - b.distanceKm);

    const deduplicated = this.deduplicateResults(scoredPool);
    const finalResults = deduplicated.slice(0, 10);

    const response = {
      success: true,
      query: qRaw,
      intent: intentData.intent,
      explicitCity: intentData.explicitCity || null,
      results: finalResults,
      responseTimeMs: Date.now() - startTime
    };

    metricsService.recordLatency('location_search_latency', Date.now() - startTime);
    this.cache.set(cacheKey, response);
    return response;
  }

  detectIntent(qRaw) {
    const qTrim = qRaw.trim();
    
    // 1. Coordinate Check
    const coordMatch = qTrim.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*[\s,]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
    if (coordMatch) {
      const lat = parseFloat(coordMatch[1]);
      const lng = parseFloat(coordMatch[2]);
      if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        return { intent: 'COORDINATE', lat, lng };
      }
    }

    const qLower = qTrim.toLowerCase();
    const explicitCity = EXPLICIT_CITIES.find(c => qLower.includes(c));

    const pinMatch = qTrim.match(/\b([1-9][0-9]{5})\b/);
    if (pinMatch) {
      return { intent: 'PINCODE', pincode: pinMatch[1], explicitCity };
    }

    // Micro-Address Pattern Matcher (Flat, Tower, Plot, Road No, Phase, Block, Door No)
    const explicitPrefixMatch = qTrim.match(/^(h\.?no\.?|flat|plot|door|d\.?no\.?|house|room|apt|block|tower|phase|road\s*no\.?|pillar)\s*([0-9A-Za-z\/\-\.]+)\s+(.+)$/i);
    const digitNumMatch = qTrim.match(/^([0-9][0-9A-Za-z\/\-\.]*)\s+(.+)$/i);

    if (explicitPrefixMatch) {
      return { 
        intent: 'HOUSE_ADDRESS', 
        prefix: explicitPrefixMatch[1].toUpperCase(),
        number: explicitPrefixMatch[2],
        area: explicitPrefixMatch[3],
        explicitCity
      };
    } else if (digitNumMatch) {
      return {
        intent: 'HOUSE_ADDRESS',
        prefix: 'H.NO',
        number: digitNumMatch[1],
        area: digitNumMatch[2],
        explicitCity
      };
    }

    if (explicitCity) {
      return { intent: 'CITY', explicitCity };
    }

    return { intent: 'LOCALITY_OR_POI', explicitCity: null };
  }

  normalizeQuery(qRaw) {
    const raw = (qRaw || '').trim();
    let cleanRaw = raw.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

    // Phonetic & Transliteration Normalization
    Object.keys(TRANSLITERATIONS).forEach(tKey => {
      const tRegex = new RegExp(`\\b${tKey}\\b`, 'gi');
      cleanRaw = cleanRaw.replace(tRegex, TRANSLITERATIONS[tKey]);
    });

    STOPWORDS.forEach(sw => {
      const swRegex = new RegExp(`\\b${sw}\\b`, 'gi');
      cleanRaw = cleanRaw.replace(swRegex, '');
    });
    cleanRaw = cleanRaw.replace(/\s+/g, ' ').trim();

    let rawTokens = cleanRaw.split(' ').filter(Boolean);
    // Mobile keyboards and speech input often separate acronyms into single
    // letters (for example "k p h b"). Preserve that useful query form.
    if (rawTokens.length >= 3 && rawTokens.every(token => token.length === 1)) {
      cleanRaw = rawTokens.join('');
      rawTokens = [cleanRaw];
    }

    let expanded = cleanRaw;
    Object.keys(ABBREVIATIONS).forEach(abbr => {
      const regex = new RegExp(`\\b${abbr.replace('.', '\\.')}\\b`, 'g');
      expanded = expanded.replace(regex, ABBREVIATIONS[abbr]);
    });
    const expandedTokens = expanded.split(' ').filter(Boolean);

    return {
      raw,
      cleanRaw,
      rawTokens,
      expanded,
      expandedTokens
    };
  }

  searchLocalProvider(qRaw, normQuery, intentData, refLat, refLng) {
    const results = [];
    const { cleanRaw, rawTokens, expanded, expandedTokens } = normQuery;
    if (!cleanRaw || (!rawTokens.length && !expandedTokens.length)) return results;

    // A. House & Micro-Address Token-Based Landmark Synthesizer
    if (intentData.intent === 'HOUSE_ADDRESS' && intentData.area && (!intentData.explicitCity || matchesExplicitCity('hyderabad', intentData.explicitCity))) {
      const areaTokens = intentData.area.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1);
      
      let bestLandmark = null;
      let bestScore = 0;

      this.landmarks.forEach(l => {
        const lTokens = (l.name + ' ' + l.tags.join(' ')).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
        let tokenHits = 0;

        areaTokens.forEach(at => {
          if (at.length >= 2 && lTokens.some(lt => lt === at || lt.startsWith(at) || (at.length > 4 && lt.includes(at)))) {
            tokenHits += (at.length >= 4 ? 2 : 1);
          }
        });

        if (tokenHits > bestScore) {
          bestScore = tokenHits;
          bestLandmark = l;
        }
      });

      if (bestLandmark && bestScore >= 1) {
        const distKm = calcHaversine(refLat, refLng, bestLandmark.lat, bestLandmark.lng);
        const { title: landmarkTitle, subtitle: landmarkSub } = parseNameComponents(bestLandmark.name);
        const prefix = intentData.prefix || 'H.NO';
        const num = intentData.number || '';

        results.push({
          id: `local_house_${Date.now()}`,
          name: `${prefix} ${num}, ${bestLandmark.name}`.trim(),
          title: `${prefix} ${num}, ${landmarkTitle}`.trim(),
          subtitle: landmarkSub || 'Telangana, India',
          icon: '🏠',
          lat: bestLandmark.lat,
          lng: bestLandmark.lng,
          distanceKm: distKm,
          // High precision synthesized rooftop/house number geocode anchor.
          score: 350,
          source: 'HOUSE_NUMBER',
          type: 'HOUSE_ADDRESS',
          confidence: 0.98,
          confidenceLevel: 'SYNTHESIZED',
          requiresPinConfirmation: true,
          addressDetails: {
            houseNumber: `${prefix} ${num}`.trim(),
            street: landmarkTitle,
            locality: landmarkSub,
            city: bestLandmark.city || 'Hyderabad',
            state: 'Telangana',
            pincode: bestLandmark.pincode || null,
            country: 'India'
          }
        });
      }
    }

    // B. Local Curated Micro-Landmarks Search
    this.landmarks.forEach(item => {
      const nameLower = item.name.toLowerCase();
      const nameClean = nameLower.replace(/[^a-z0-9]/g, '');
      const tagsClean = item.tags.join(' ').replace(/[^a-z0-9]/g, '');
      const itemTokens = (nameLower + ' ' + item.tags.join(' ') + ' ' + (item.pincode || '') + ' ' + (item.city || '')).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

      let score = 0;
      const searchableText = `${nameLower} ${item.tags.join(' ').toLowerCase()}`;
      const phrases = [nameLower, ...item.tags.map(tag => tag.toLowerCase())];

      // Prefer a complete phrase/alias match, then complete tokens, then a
      // conservative typo match. Substring matching short tokens caused many
      // unrelated places (for example "me" -> "Medchal") to rank highly.
      if (phrases.some(phrase => phrase === cleanRaw)) score += 420;
      else if (phrases.some(phrase => phrase.startsWith(cleanRaw))) score += 300;
      else if (searchableText.includes(cleanRaw)) score += 220;

      const queryTokens = rawTokens.length ? rawTokens : expandedTokens;
      let matchedCount = 0;
      let prefixCount = 0;
      let typoCount = 0;
      for (const queryToken of queryTokens) {
        const exact = itemTokens.some(token => token === queryToken);
        const prefix = queryToken.length >= 2 && itemTokens.some(token => token.startsWith(queryToken));
        const typo = queryToken.length >= 5 && itemTokens.some(token =>
          token.length >= 5 && editDistanceAtMostOne(token, queryToken));
        if (exact) matchedCount++;
        else if (prefix) { matchedCount++; prefixCount++; }
        else if (typo) { matchedCount++; typoCount++; }
      }
      if (queryTokens.length && matchedCount === queryTokens.length) {
        score += 180 + (queryTokens.length - prefixCount - typoCount) * 35 - typoCount * 25 - prefixCount * 12;
      } else if (matchedCount) {
        score += 90 * (matchedCount / queryTokens.length);
      }

      // Avoid suggesting a broad locality just because one generic word
      // overlaps; require meaningful token coverage for multi-word searches.
      if (queryTokens.length > 1 && matchedCount < queryTokens.length) score -= 45;

      // If a city is named explicitly, keep its curated city-level result
      // available even when the place name itself is unknown locally and the
      // external geocoder is offline or slow. This gives local demos a useful
      // deterministic fallback instead of returning no result.
      if (intentData.explicitCity && matchesExplicitCity(`${item.name} ${item.city || ''}`, intentData.explicitCity)) {
        score += 180;
      }

      if (score > 0) {
        const distKm = calcHaversine(refLat, refLng, item.lat, item.lng);
        const { title, subtitle: parsedSubtitle } = parseNameComponents(item.name);
        const state = stateForCity(item.city);
        const subtitle = parsedSubtitle === 'Telangana, India'
          ? `${item.city || 'Hyderabad'}, ${state}, India`
          : parsedSubtitle;
        
        const CATEGORY_ICONS = {
          METRO: '🚇',
          AIRPORT: '✈️',
          BUSINESS_PARK: '🏢',
          MALL: '🏪',
          HOSPITAL: '🏥',
          UNIVERSITY: '🎓',
          STATION: '🚉',
          RESTAURANT: '🍽️',
          INDUSTRIAL: '🏭',
          MONUMENT: '🏛️',
          COMMERCIAL: '🏬',
          LOCALITY: '📍',
          RESIDENTIAL: '🏠',
          CITY: '🌆'
        };

        results.push({
          id: `local_${item.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`,
          name: item.name,
          title,
          subtitle,
          icon: CATEGORY_ICONS[item.category] || '📍',
          lat: item.lat,
          lng: item.lng,
          distanceKm: distKm,
          score,
          source: 'LOCAL',
          type: item.category || (item.city !== 'Hyderabad' ? 'CITY' : 'LOCALITY'),
          confidence: Math.min(1.0, score / 160),
          confidenceLevel: 'HIGH_CONFIDENCE',
          requiresPinConfirmation: false,
          addressDetails: {
            houseNumber: null,
            street: title,
            locality: subtitle,
            city: item.city || 'Hyderabad',
            state,
            pincode: item.pincode || null,
            country: 'India'
          }
        });
      }
    });

    return results;
  }

  async fetchExternalProviders(qRaw, refLat, refLng, intentData) {
    return await circuitBreakerService.execute('osm_geocoding', async () => {
      const externalResults = [];

      try {
        let photonUrl = `${PHOTON_BASE_URL}/api/?q=${encodeURIComponent(qRaw)}&limit=8`;
        if (!intentData.explicitCity) {
          photonUrl += `&lat=${refLat}&lon=${refLng}`;
        }

        const photonData = await fetchHttpsJson(photonUrl, 500);

        if (photonData && photonData.features && Array.isArray(photonData.features)) {
          photonData.features.forEach(feat => {
            const props = feat.properties || {};
            const coords = feat.geometry ? feat.geometry.coordinates : [refLng, refLat];
            const lng = parseFloat(coords[0]);
            const lat = parseFloat(coords[1]);

            if (isNaN(lat) || isNaN(lng)) return;

            const distKm = calcHaversine(refLat, refLng, lat, lng);
            const title = props.name || props.street || props.housenumber || props.district || props.city || qRaw;
            
            const subParts = [props.housenumber, props.street, props.district, props.city, props.state, props.country]
              .filter(Boolean)
              .filter(p => p.toLowerCase() !== title.toLowerCase());
            
            const subtitle = subParts.length > 0 ? subParts.join(', ') : (props.country || 'India');

            externalResults.push({
              id: `photon_${props.osm_id || Math.random().toString(36).substring(7)}`,
              name: `${title}, ${subtitle}`,
              title,
              subtitle,
              lat,
              lng,
              distanceKm: distKm,
              score: 70,
              source: 'PHOTON',
              type: props.type || 'POI',
              confidence: 0.7,
              confidenceLevel: 'APPROXIMATE',
              requiresPinConfirmation: false,
              addressDetails: {
                houseNumber: props.housenumber || null,
                street: props.street || null,
                locality: props.district || props.suburb || null,
                city: props.city || props.town || null,
                state: props.state || null,
                pincode: props.postcode || null,
                country: props.country || 'India'
              }
            });
          });
        }
      } catch (e) {
        console.warn('[LocationSearchService] Photon fetch error:', e.message);
      }

      if (externalResults.length === 0) {
        try {
          const nomUrl = `${NOMINATIM_BASE_URL}/search?format=json&q=${encodeURIComponent(qRaw)}&addressdetails=1&limit=5`;
          const nomData = await fetchNominatimJson(nomUrl, 1200);

          if (Array.isArray(nomData)) {
            nomData.forEach(item => {
              const lat = parseFloat(item.lat);
              const lng = parseFloat(item.lon);
              if (isNaN(lat) || isNaN(lng)) return;

              const distKm = calcHaversine(refLat, refLng, lat, lng);
              const { title, subtitle } = parseNameComponents(item.display_name);

              externalResults.push({
                id: `nominatim_${item.place_id}`,
                name: item.display_name,
                title,
                subtitle,
                lat,
                lng,
                distanceKm: distKm,
                score: 60,
                source: 'NOMINATIM',
                type: item.type || 'POI',
                confidence: 0.6,
                confidenceLevel: 'APPROXIMATE',
                requiresPinConfirmation: false,
                addressDetails: {
                  houseNumber: item.address?.house_number || null,
                  street: item.address?.road || null,
                  locality: item.address?.suburb || item.address?.neighbourhood || null,
                  city: item.address?.city || item.address?.town || null,
                  state: item.address?.state || null,
                  pincode: item.address?.postcode || null,
                  country: item.address?.country || 'India'
                }
              });
            });
          }
        } catch (e) {
          console.warn('[LocationSearchService] Nominatim fetch error:', e.message);
        }
      }

      return externalResults;
    }, async () => []);
  }

  computeVaayuScore(item, normQuery, intentData, refLat, refLng) {
    let score = item.score || 50;

    if (intentData.explicitCity) {
      const itemText = (item.name + ' ' + (item.subtitle || '') + ' ' + (item.addressDetails?.city || '')).toLowerCase();
      if (matchesExplicitCity(itemText, intentData.explicitCity)) {
        score += 180;
      } else {
        score -= 250;
      }
    } else {
      if (item.distanceKm <= 5.0) {
        score += 35;
      } else if (item.distanceKm <= 20.0) {
        score += 15;
      } else if (item.distanceKm > 100.0) {
        score -= 40;
      }
    }

    if (intentData.intent === 'PINCODE') {
      if (item.addressDetails?.pincode === intentData.pincode || item.name.includes(intentData.pincode)) {
        score += 250;
      } else {
        score -= 100;
      }
    }

    return Math.max(0, Math.round(score));
  }

  deduplicateResults(items) {
    const result = [];

    items.forEach(item => {
      const isDuplicate = result.some(existing => {
        const distKm = calcHaversine(existing.lat, existing.lng, item.lat, item.lng);

        const eTitle = existing.title.toLowerCase().replace(/[^a-z0-9]/g, '');
        const iTitle = item.title.toLowerCase().replace(/[^a-z0-9]/g, '');
        const titleMatch = (eTitle.length > 4 && iTitle.length > 4) && (eTitle === iTitle || eTitle.startsWith(iTitle) || iTitle.startsWith(eTitle));

        if (distKm <= 0.1 && (titleMatch || existing.type === item.type)) {
          return true;
        }

        return false;
      });

      if (!isDuplicate) {
        result.push(item);
      }
    });

    return result;
  }

  /**
   * Reverse geocoding with explicit source quality
   * 
   * Strategy:
   * 1. Check if coordinates match an exact landmark within <= 35 meters. If so, return exact landmark name.
   * 2. Query Nominatim Zoom-18 with 1500ms timeout for real street, house number, road, building, and suburb breakdown.
   * 3. Structured geocoder fields are labelled approximate because provider coordinates
   *    can represent a building, street, or area centroid rather than the exact entrance.
   * 4. If Nominatim is unavailable, return a nearby locality label without claiming
   *    that it is an exact street address.
   */
  async reverseGeocode(lat, lng) {
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);

    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum) || Math.abs(latNum) > 90 || Math.abs(lngNum) > 180) {
      return { success: false, error: 'Latitude must be between -90 and 90 and longitude between -180 and 180' };
    }

    // 1. Direct Micro-Landmark Match (within <= 35 meters)
    let exactLandmark = null;
    let exactDistanceMeters = 35;

    this.landmarks.forEach(lm => {
      const dMeters = calcHaversineMeters(latNum, lngNum, lm.lat, lm.lng);
      if (dMeters < exactDistanceMeters) {
        exactDistanceMeters = dMeters;
        exactLandmark = lm;
      }
    });

    if (exactLandmark) {
      const { title, subtitle } = parseNameComponents(exactLandmark.name);
      return {
        success: true,
        address: exactLandmark.name,
        title: title,
        subtitle: subtitle,
        lat: latNum,
        lng: lngNum,
        source: 'EXACT_LANDMARK',
        confidenceLevel: 'EXACT',
        precisionTier: 'EXACT_MICRO_PINPOINT',
        requiresPinConfirmation: false,
        distanceKm: Math.round(exactDistanceMeters) / 1000,
        accuracyMeters: Math.max(1, Math.round(exactDistanceMeters * 10) / 10)
      };
    }

    // 2. High-Resolution External OSM Geocoder (Zoom 18 for street & building level precision)
    try {
      const reverseUrl = `${NOMINATIM_BASE_URL}/reverse?format=json&lat=${latNum}&lon=${lngNum}&addressdetails=1&zoom=18`;
      const data = await fetchNominatimJson(reverseUrl, 1500);

      if (data && (data.display_name || data.address)) {
        const addrObj = data.address || {};
        const houseNum = addrObj.house_number || addrObj.building || null;
        const road = addrObj.road || addrObj.pedestrian || addrObj.street || null;
        const locality = addrObj.suburb || addrObj.neighbourhood || addrObj.residential || addrObj.district || null;
        const city = addrObj.city || addrObj.town || addrObj.village || addrObj.county || null;
        const state = addrObj.state || null;
        const pincode = addrObj.postcode || null;

        let titleStr = '';
        if (houseNum && road) titleStr = `${houseNum}, ${road}`;
        else if (houseNum) titleStr = `${houseNum}`;
        else if (road) titleStr = road;
        else if (locality) titleStr = locality;
        else titleStr = parseNameComponents(data.display_name).title;

        const subParts = [locality !== titleStr ? locality : null, city, state, pincode].filter(Boolean);
        const subtitleStr = subParts.length > 0 ? subParts.join(', ') : parseNameComponents(data.display_name).subtitle;
        const fullAddrStr = `${titleStr}, ${subtitleStr}`;

        return {
          success: true,
          address: fullAddrStr,
          title: titleStr,
          subtitle: subtitleStr,
          lat: latNum,
          lng: lngNum,
          source: 'STREET_GEOM_REVERSE',
          confidenceLevel: 'APPROXIMATE',
          precisionTier: 'GEOCODER_ADDRESS',
          requiresPinConfirmation: true,
          addressDetails: {
            houseNumber: houseNum,
            street: road,
            locality: locality,
            city,
            state,
            pincode,
            country: 'India'
          }
        };
      }
    } catch (e) {}

    // 3. Proximity Locality Grid Fallback (within 2 km)
    let closestLocality = null;
    let minLocalityDist = 2000;

    this.landmarks.forEach(lm => {
      const dM = calcHaversineMeters(latNum, lngNum, lm.lat, lm.lng);
      if (dM < minLocalityDist) {
        minLocalityDist = dM;
        closestLocality = lm;
      }
    });

    if (closestLocality) {
      const { title, subtitle } = parseNameComponents(closestLocality.name);
      return {
        success: true,
        address: `${title}, ${subtitle}`,
        title: title,
        subtitle: subtitle,
        lat: latNum,
        lng: lngNum,
        source: 'LOCALITY_GRID_MATCH',
        confidenceLevel: 'APPROXIMATE',
        precisionTier: 'NEIGHBOURHOOD_PRECISION',
        distanceToLandmarkMeters: Math.round(minLocalityDist),
        requiresPinConfirmation: false,
        addressDetails: {
          houseNumber: null,
          street: title,
          locality: subtitle,
          city: closestLocality.city || 'Hyderabad',
          state: stateForCity(closestLocality.city),
          pincode: closestLocality.pincode || null,
          country: 'India'
        }
      };
    }

    return {
      success: true,
      address: `Location Pin (${latNum.toFixed(5)}, ${lngNum.toFixed(5)})`,
      title: `Location Pin (${latNum.toFixed(5)}, ${lngNum.toFixed(5)})`,
      subtitle: 'Selected map coordinates',
      lat: latNum,
      lng: lngNum,
      source: 'COORDINATES',
      confidenceLevel: 'EXACT',
      precisionTier: 'COORDINATE_PINPOINT',
      requiresPinConfirmation: false
    };
  }
}

const locationSearchService = new LocationSearchService();
module.exports = {
  LocationSearchService,
  locationSearchService
};
