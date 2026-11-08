import React,{useState} from 'react';
import {Coffee,Utensils,Croissant,Gift,ShoppingBag} from 'lucide-react';
export const brandImages={'Tim Hortons':'tim-hortons.svg','Grand River Transit':'grt.png','Matter of Taste':'matter-of-taste.png','Princess Cafe':'princess.png','Seven Shores':'seven-shores.png','Smile Tiger':'smile-tiger.png','Cafe Pyrus':'cafe-pyrus.png'};
const demoBrands={'Maple Loop Coffee':[Coffee,'Maple Loop','COFFEE'],'Grand River Dumplings':[Utensils,'Grand River','DUMPLINGS'],'Uptown Shawarma House':[Utensils,'Uptown','SHAWARMA'],'Belmont Bakehouse':[Croissant,'Belmont','BAKEHOUSE'],'Commutr Demo Gift Card':[Gift,'Commutr','GIFT CARD']};
export default function MerchantLogo({place}){
 const [failed,setFailed]=useState(false);
 if(brandImages[place]&&!failed)return <img className="merchant-logo" src={'/brands/'+brandImages[place]} alt={place} onError={()=>setFailed(true)}/>;
 const [Icon,name,label]=demoBrands[place]||[ShoppingBag,place,'LOCAL REWARD'];
 return <span className="merchant-identity" aria-label={place}><Icon size={30} strokeWidth={1.6}/><strong>{name}</strong><small>{label}</small></span>;
}
