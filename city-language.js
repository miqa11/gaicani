/* Georgian display labels. Protocol identifiers and player-authored text stay unchanged. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.GaicaniCityLanguage=api;})(typeof window==='undefined'?globalThis:window,function(){
  const labels={solo:'მარტო',multiplayer:'მეგობრებთან',common:'ჩვეულებრივი',rare:'იშვიათი',legendary:'ლეგენდარული',landmark:'ღირსშესანიშნაობა',vehicle:'მანქანა',citizen:'მოქალაქე',player:'მოთამაშე',city:'ქალაქი',pizza:'პიცა',flowers:'ყვავილები',package:'ამანათი',letter:'წერილი',buy:'ყიდვა',sell:'გაყიდვა',peach:'ატამი',soda:'გაზიანი წყალი',mint:'პიტნა',lemon:'ლიმონი',ice:'ყინული',berry:'კენკრა',water:'წყალი',tires:'საბურავები',engine:'ძრავა',lights:'ფარები',tighten:'დამაგრება',neon:'ნეონის',gold:'ოქროს',wave:'ხელის დაქნევა',dance:'ცეკვა',teapot:'ჩაიდანი',pager:'პეიჯერი',umbrella:'ქოლგა',alone:'მარტო',together:'ერთად',coins:'მონეტები',
    'Lucky win!':'იღბლიანი მოგება!','Rematch?':'კიდევ ვითამაშოთ?','You got me!':'მაჯობე!','One more round!':'კიდევ ერთი რაუნდი!',
    'Neon Tbilisi':'ნეონის თბილისი','Retro Internet Café':'რეტრო ინტერნეტკაფე','Lucky Cat':'იღბლიანი კატა','Midnight Express':'შუაღამის ექსპრესი'};
  return {label:value=>labels[value]??value,answer:value=>Object.keys(labels).find(key=>labels[key]===value)??value};
});
