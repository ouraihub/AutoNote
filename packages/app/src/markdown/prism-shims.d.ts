declare module 'prismjs/components/prism-core' {
  import Prism from 'prismjs'
  export default Prism
}

declare module 'prismjs/components/*' {
  const component: unknown
  export default component
}
