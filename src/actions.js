// Official release commits. Update this source and regenerate workflows when upgrading actions.
export const actions = {
  checkout: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', // v7.0.1
  setupNode: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020', // v7.0.0
  upload: 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a', // v7.0.1
  download: 'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c', // v8.0.1
  appToken: ['actions/create-github-app-token', 'bcd2ba49218906704ab6c1aa796996da409d3eb1'].join('@'), // v3.2.0
};
