export const OWNER='tyler-hattori';
export const REPO='trivia';
export const BRANCH='main';

export const DATASETS=[
  {
    key:'art',
    color:'#DB2777',   // timeline hue; lane shades derive from it
    title:'Art History',
    file:'datasets/art.csv',
    count:0,
    layout:'portrait',
    schema: {
      type: 'image',
      fields: ['title','artist','year','movement','excerpt']
    },
    map: {
      image: 'image',
      title: 'title',
      subtitle: 'artist',
      years: 'year',
      misc: 'movement',
      excerpt: 'excerpt'
    },
    timeline: {
      type: 'point',
      filterable: [
        { key:'misc', label:'Movement' },
        { key:'subtitle', label:'Artist' }
      ]
    }
  },
  {
    key:'leaders',
    color:'#7C3AED',   // timeline hue; lane shades derive from it
    title:'World Leaders',
    file:'datasets/leaders.csv',
    count:0,
    layout:'split',
    schema: {
      type: 'image',
      fields: ['name','country','years','house/party','excerpt']
    },
    map: {
      image: 'image',
      title: 'name',
      subtitle: 'country',
      years: 'years',
      misc: 'house/party',
      excerpt: 'excerpt'
    },
    timeline: {
      type: 'span',
      filterable: [
        { key:'misc', label:'House/Party' },
        { key:'subtitle', label:'Country' }
      ]
    }
  },
  {
    key:'film',
    color:'#2563EB',   // timeline hue; lane shades derive from it
    title:'Film History',
    file:'datasets/film.csv',
    count:0,
    layout:'wide',
    schema: {
      type: 'event',
      fields: ['title','year','director','image','excerpt']
    },
    map: {
      image: 'image',
      title: 'title',
      subtitle: 'director',
      years: 'year',
      misc: '',
      excerpt: 'excerpt'
    },
    timeline: {
      type: 'point',
      filterable: [
        { key:'subtitle', label:'Director' }
      ]
    }
  },
  {
    key:'philosophy',
    color:'#D97706',   // timeline hue; lane shades derive from it
    title:'Philosophy',
    file:'datasets/philosophy.csv',
    count:0,
    layout:'portrait',
    schema: {
      type: 'image',
      fields: ['work','philosopher','year','school','excerpt']
    },
    map: {
      image: 'image',
      title: 'work',
      subtitle: 'philosopher',
      years: 'year',
      misc: 'school',
      excerpt: 'excerpt'
    },
    timeline: {
      type: 'point',
      filterable: [
        { key:'misc', label:'School' },
        { key:'subtitle', label:'Philosopher' }
      ]
    }
  },
  {
    key:'science',
    color:'#0891B2',   // timeline hue; lane shades derive from it
    title:'Science & Discovery',
    file:'datasets/science.csv',
    count:0,
    layout:'wide',
    schema: {
      type: 'image',
      fields: ['discovery','scientist','year','field','excerpt']
    },
    map: {
      image: 'image',
      title: 'discovery',
      subtitle: 'scientist',
      years: 'year',
      misc: 'field',
      excerpt: 'excerpt'
    },
    timeline: {
      type: 'point',
      filterable: [
        { key:'misc', label:'Field' },
        { key:'subtitle', label:'Scientist' }
      ]
    }
  },
  {
    key:'religion',
    color:'#16A34A',   // timeline hue; lane shades derive from it
    title:'Religion',
    file:'datasets/religion.csv',
    count:0,
    layout:'portrait',
    schema: {
      type: 'image',
      fields: ['event','tradition','year','region','excerpt']
    },
    map: {
      image: 'image',
      title: 'event',
      subtitle: 'tradition',
      years: 'year',
      misc: 'region',
      excerpt: 'excerpt'
    },
    timeline: {
      type: 'point',
      filterable: [
        { key:'subtitle', label:'Tradition' },
        { key:'misc', label:'Region' }
      ]
    }
  },
  {
    key:'us_history',
    color:'#DC2626',   // timeline hue; lane shades derive from it
    title:'U.S. History',
    file:'datasets/us_history.csv',
    count:0,
    layout:'wide',
    schema: {
      type: 'image',
      fields: ['event','year','category','excerpt']
    },
    map: {
      image: 'image',
      title: 'event',
      subtitle: 'category',
      years: 'year',
      misc: 'category',
      excerpt: 'excerpt'
    },
    timeline: {
      type: 'point',
      filterable: [
        { key:'misc', label:'Category' }
      ]
    }
  },
  {
    key:'people',
    color:'#EA580C',   // timeline hue; lane shades derive from it
    title:'Notable People',
    file:'datasets/people.csv',
    count:0,
    layout:'split',
    schema: {
      type: 'image',
      fields: ['name','years','occupation','country','excerpt']
    },
    map: {
      image: 'image',
      title: 'name',
      subtitle: 'occupation',
      years: 'years',
      misc: 'country',
      excerpt: 'excerpt'
    },
    timeline: {
      type: 'span',
      filterable: [
        { key:'subtitle', label:'Occupation' },
        { key:'misc', label:'Country' }
      ]
    }
  }
];

export const TIMELINE_SETTINGS = {
    MIN_CARD_W: 10,
    MAX_CARD_W: 320,
    IMG_H: 104
}
