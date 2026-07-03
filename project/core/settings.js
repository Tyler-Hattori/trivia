export const OWNER='tyler-hattori';
export const REPO='trivia';
export const BRANCH='main';

export const DATASETS=[
  {
    key:'art',
    title:'Art History',
    file:'datasets/art.csv',
    count:10,
    schema: {
      type: 'image',
      fields: ['title','artist','year','movement']
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
    title:'World Leaders',
    file:'datasets/leaders.csv',
    count:10,
    schema: {
      type: 'image',
      fields: ['name','country','years','house/party']
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
  }
];

export const TIMELINE_SETTINGS = {
    MIN_CARD_W: 10,
    MAX_CARD_W: 320,
    IMG_H: 104
}
